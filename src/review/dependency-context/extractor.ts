import { access, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { DiffFile } from '../../git/parser.js';
import type {
  FrontendDependencyContext,
  FrontendDependencySnapshot,
  FrontendDependencyVersion,
  FrontendPackageManager,
} from './types.js';

interface PackageManifestData {
  packageRootAbsolute: string;
  packageRootRelative: string;
  declaredVersions: Map<string, string>;
  hasFrontendDependencies: boolean;
}

interface LockResolution {
  packageManager: FrontendPackageManager;
  resolvedVersions: Map<string, string>;
}

const FRONTEND_FILE_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'vue',
  'svelte',
  'css',
  'scss',
  'sass',
  'less',
]);

const FRONTEND_FRAMEWORK_PACKAGES = [
  'react',
  'react-dom',
  'react-router',
  'react-router-dom',
  'antd-mobile',
  'vue',
  'vue-router',
  'pinia',
  'svelte',
  '@sveltejs/kit',
  'next',
  'nuxt',
  '@angular/core',
  'preact',
  'solid-js',
  '@tanstack/react-query',
  'swr',
  'redux',
  '@reduxjs/toolkit',
  'zustand',
  'mobx',
  'mobx-react-lite',
  'antd',
  '@mui/material',
  'element-plus',
  'tailwindcss',
];

const FRONTEND_FRAMEWORK_SET = new Set(FRONTEND_FRAMEWORK_PACKAGES);

const IMPORT_PATTERNS = [
  /from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const MAX_FRONTEND_DEPENDENCIES = 8;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function getFileExtension(filePath: string): string {
  const fileName = normalizePath(filePath).split('/').pop() || '';
  const parts = fileName.split('.');
  return parts.length > 1 ? parts[parts.length - 1]!.toLowerCase() : '';
}

function normalizePackageName(specifier: string): string | undefined {
  if (
    !specifier ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#')
  ) {
    return undefined;
  }

  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }

  return specifier.split('/')[0];
}

function collectImportedPackages(diffContent: string): Set<string> {
  const packages = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    for (const match of diffContent.matchAll(pattern)) {
      const normalized = normalizePackageName(match[1] || '');
      if (normalized) {
        packages.add(normalized);
      }
    }
  }

  return packages;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findNearestPackageRoot(
  repoPath: string,
  filePath: string
): Promise<string | undefined> {
  const absoluteRepoPath = resolve(repoPath);
  let current = dirname(resolve(repoPath, filePath));

  while (normalizePath(current).startsWith(normalizePath(absoluteRepoPath))) {
    if (await pathExists(join(current, 'package.json'))) {
      return current;
    }
    if (current === absoluteRepoPath) {
      break;
    }
    current = dirname(current);
  }

  return undefined;
}

function getDeclaredVersions(packageJson: Record<string, any>): Map<string, string> {
  const versions = new Map<string, string>();
  const sections = [
    packageJson.dependencies,
    packageJson.peerDependencies,
    packageJson.optionalDependencies,
    packageJson.devDependencies,
  ];

  for (const section of sections) {
    if (!section || typeof section !== 'object') {
      continue;
    }

    for (const [name, version] of Object.entries(section)) {
      if (typeof version === 'string' && !versions.has(name)) {
        versions.set(name, version);
      }
    }
  }

  return versions;
}

async function loadPackageManifest(
  repoPath: string,
  packageRootAbsolute: string
): Promise<PackageManifestData> {
  const packageJson = JSON.parse(
    await readFile(join(packageRootAbsolute, 'package.json'), 'utf8')
  ) as Record<string, any>;
  const declaredVersions = getDeclaredVersions(packageJson);

  return {
    packageRootAbsolute,
    packageRootRelative: normalizePath(relative(repoPath, packageRootAbsolute) || '.'),
    declaredVersions,
    hasFrontendDependencies: Array.from(declaredVersions.keys()).some((name) =>
      FRONTEND_FRAMEWORK_SET.has(name)
    ),
  };
}

function stripPnpmPeerSuffix(version: string): string {
  return version.replace(/\(.*$/, '');
}

function parseResolvedVersion(rawVersion: unknown): string | undefined {
  return typeof rawVersion === 'string' && rawVersion.trim()
    ? stripPnpmPeerSuffix(rawVersion)
    : undefined;
}

function extractComparableVersion(version: string | undefined): [number, number, number] | null {
  if (!version) {
    return null;
  }

  const match = version.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    return null;
  }

  return [
    Number.parseInt(match[1] || '0', 10),
    Number.parseInt(match[2] || '0', 10),
    Number.parseInt(match[3] || '0', 10),
  ];
}

function compareVersions(
  left: [number, number, number] | null,
  right: [number, number, number]
): number {
  if (!left) {
    return -1;
  }

  for (let index = 0; index < right.length; index++) {
    const leftPart = left[index] || 0;
    const rightPart = right[index] || 0;

    if (leftPart > rightPart) {
      return 1;
    }
    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

function isVersionAtLeast(version: string | undefined, minimum: [number, number, number]): boolean {
  return compareVersions(extractComparableVersion(version), minimum) >= 0;
}

async function findNearestLockFile(
  repoPath: string,
  packageRootAbsolute: string
): Promise<{ packageManager: FrontendPackageManager; filePath: string } | undefined> {
  const absoluteRepoPath = resolve(repoPath);
  let current = packageRootAbsolute;

  while (normalizePath(current).startsWith(normalizePath(absoluteRepoPath))) {
    const npmLock = join(current, 'package-lock.json');
    if (await pathExists(npmLock)) {
      return { packageManager: 'npm', filePath: npmLock };
    }

    const pnpmLock = join(current, 'pnpm-lock.yaml');
    if (await pathExists(pnpmLock)) {
      return { packageManager: 'pnpm', filePath: pnpmLock };
    }

    if (current === absoluteRepoPath) {
      break;
    }

    current = dirname(current);
  }

  return undefined;
}

async function resolveVersionsFromNpmLock(
  lockPath: string,
  dependencyNames: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, any>;
  const packages = parsed.packages && typeof parsed.packages === 'object' ? parsed.packages : {};
  const dependencies =
    parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {};

  for (const name of dependencyNames) {
    const packageEntry = packages[`node_modules/${name}`];
    if (packageEntry?.version && typeof packageEntry.version === 'string') {
      result.set(name, packageEntry.version);
      continue;
    }

    const dependencyEntry = dependencies[name];
    if (dependencyEntry?.version && typeof dependencyEntry.version === 'string') {
      result.set(name, dependencyEntry.version);
    }
  }

  return result;
}

async function resolveVersionsFromPnpmLock(
  lockPath: string,
  packageRootAbsolute: string,
  dependencyNames: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const parsed = parseYaml(await readFile(lockPath, 'utf8')) as Record<string, any>;
  const lockDir = dirname(lockPath);
  const importerKey = normalizePath(relative(lockDir, packageRootAbsolute) || '.');
  const importers =
    parsed.importers && typeof parsed.importers === 'object' ? parsed.importers : {};
  const importer = importers[importerKey] ?? importers['.'];

  if (importer && typeof importer === 'object') {
    for (const groupName of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const group = importer[groupName];
      if (!group || typeof group !== 'object') {
        continue;
      }

      for (const name of dependencyNames) {
        const entry = group[name];
        if (!entry || result.has(name)) {
          continue;
        }

        if (typeof entry === 'string') {
          result.set(name, stripPnpmPeerSuffix(entry));
          continue;
        }

        if (typeof entry === 'object') {
          const version = parseResolvedVersion(entry.version);
          if (version) {
            result.set(name, version);
          }
        }
      }
    }
  }

  return result;
}

async function resolveLockVersions(
  repoPath: string,
  packageRootAbsolute: string,
  dependencyNames: string[]
): Promise<LockResolution> {
  const lockFile = await findNearestLockFile(repoPath, packageRootAbsolute);
  if (!lockFile) {
    return {
      packageManager: 'unknown',
      resolvedVersions: new Map<string, string>(),
    };
  }

  if (lockFile.packageManager === 'npm') {
    return {
      packageManager: 'npm',
      resolvedVersions: await resolveVersionsFromNpmLock(lockFile.filePath, dependencyNames),
    };
  }

  if (lockFile.packageManager === 'pnpm') {
    return {
      packageManager: 'pnpm',
      resolvedVersions: await resolveVersionsFromPnpmLock(
        lockFile.filePath,
        packageRootAbsolute,
        dependencyNames
      ),
    };
  }

  return {
    packageManager: 'unknown',
    resolvedVersions: new Map<string, string>(),
  };
}

function buildDependencyList(
  manifest: PackageManifestData,
  importedPackages: Set<string>
): string[] {
  const names = new Set<string>();
  const priorityNames = new Set<string>();

  for (const name of importedPackages) {
    if (manifest.declaredVersions.has(name)) {
      names.add(name);
    }
  }

  for (const name of FRONTEND_FRAMEWORK_PACKAGES) {
    if (manifest.declaredVersions.has(name)) {
      names.add(name);
      priorityNames.add(name);
    }
  }

  return Array.from(names)
    .sort((left, right) => {
      const priorityDelta = Number(priorityNames.has(right)) - Number(priorityNames.has(left));
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return left.localeCompare(right);
    })
    .slice(0, MAX_FRONTEND_DEPENDENCIES);
}

function isFrontendCandidateFile(
  file: DiffFile,
  manifest: PackageManifestData,
  importedPackages: Set<string>
): boolean {
  const ext = getFileExtension(file.path);
  if (!FRONTEND_FILE_EXTENSIONS.has(ext)) {
    return false;
  }

  if (manifest.hasFrontendDependencies) {
    return true;
  }

  return Array.from(importedPackages).some((name) => FRONTEND_FRAMEWORK_SET.has(name));
}

export async function extractFrontendDependencyContext(
  repoPath: string,
  diffFiles: DiffFile[]
): Promise<FrontendDependencyContext | undefined> {
  const manifestCache = new Map<string, PackageManifestData>();
  const groupedFiles = new Map<
    string,
    {
      manifest: PackageManifestData;
      appliesToFiles: Set<string>;
      importedPackages: Set<string>;
    }
  >();

  for (const file of diffFiles) {
    const packageRootAbsolute = await findNearestPackageRoot(repoPath, file.path);
    if (!packageRootAbsolute) {
      continue;
    }

    let manifest = manifestCache.get(packageRootAbsolute);
    if (!manifest) {
      manifest = await loadPackageManifest(repoPath, packageRootAbsolute);
      manifestCache.set(packageRootAbsolute, manifest);
    }

    const importedPackages = collectImportedPackages(file.content);
    if (!isFrontendCandidateFile(file, manifest, importedPackages)) {
      continue;
    }

    const existing =
      groupedFiles.get(packageRootAbsolute) ||
      (() => {
        const created = {
          manifest,
          appliesToFiles: new Set<string>(),
          importedPackages: new Set<string>(),
        };
        groupedFiles.set(packageRootAbsolute, created);
        return created;
      })();

    existing.appliesToFiles.add(normalizePath(file.path));
    for (const name of importedPackages) {
      existing.importedPackages.add(name);
    }
  }

  if (groupedFiles.size === 0) {
    return undefined;
  }

  const snapshots: FrontendDependencySnapshot[] = [];

  for (const [packageRootAbsolute, grouped] of groupedFiles) {
    const dependencyNames = buildDependencyList(grouped.manifest, grouped.importedPackages);
    if (dependencyNames.length === 0) {
      continue;
    }

    const lockResolution = await resolveLockVersions(
      repoPath,
      packageRootAbsolute,
      dependencyNames
    );
    const dependencies: FrontendDependencyVersion[] = dependencyNames.map((name) => ({
      name,
      declaredVersion: grouped.manifest.declaredVersions.get(name),
      resolvedVersion: lockResolution.resolvedVersions.get(name),
    }));

    snapshots.push({
      packageRoot: grouped.manifest.packageRootRelative,
      packageManager: lockResolution.packageManager,
      appliesToFiles: Array.from(grouped.appliesToFiles).sort((left, right) =>
        left.localeCompare(right)
      ),
      dependencies,
    });
  }

  if (snapshots.length === 0) {
    return undefined;
  }

  return { snapshots };
}

export function selectFrontendDependencySnapshot(
  context: FrontendDependencyContext | undefined,
  filePath: string
): FrontendDependencySnapshot | undefined {
  if (!context) {
    return undefined;
  }

  const normalizedFilePath = normalizePath(filePath);

  return context.snapshots.find((snapshot) =>
    snapshot.appliesToFiles.some((candidate) => normalizedFilePath === candidate)
  );
}

export function formatFrontendDependencyContext(
  context: FrontendDependencyContext,
  filePath?: string
): string {
  const snapshots = filePath
    ? (() => {
        const selected = selectFrontendDependencySnapshot(context, filePath);
        return selected ? [selected] : [];
      })()
    : context.snapshots;

  if (snapshots.length === 0) {
    return '';
  }

  const lines: string[] = ['## Frontend Dependency Versions', ''];

  for (const snapshot of snapshots) {
    lines.push(`- Package root: ${snapshot.packageRoot}`);
    lines.push(`- Package manager: ${snapshot.packageManager}`);
    for (const dependency of snapshot.dependencies) {
      const declared = dependency.declaredVersion || 'unknown';
      const resolved = dependency.resolvedVersion || 'exact version unknown';
      lines.push(`- ${dependency.name}: declared ${declared}, resolved ${resolved}`);
    }

    const dependencyVersionByName = new Map(
      snapshot.dependencies.map((dependency) => [
        dependency.name,
        dependency.resolvedVersion || dependency.declaredVersion,
      ])
    );
    const capabilityNotes: string[] = [];
    const reactVersion = dependencyVersionByName.get('react');
    const antdMobileVersion = dependencyVersionByName.get('antd-mobile');

    if (isVersionAtLeast(reactVersion, [19, 0, 0])) {
      capabilityNotes.push(
        'React modern ref semantics (react >= 19): function components may receive ref as a regular prop; do not require forwardRef solely because a component receives or passes ref.'
      );
      capabilityNotes.push(
        'React modern ref semantics (react >= 19): useImperativeHandle(ref, ...) can be valid when ref is received from props.'
      );
    }

    if (isVersionAtLeast(reactVersion, [19, 2, 0])) {
      capabilityNotes.push(
        'React hook availability (react >= 19.2): useEffectEvent is supported for these grounded versions.'
      );
    }

    if (
      isVersionAtLeast(reactVersion, [19, 0, 0]) &&
      isVersionAtLeast(antdMobileVersion, [5, 40, 0])
    ) {
      capabilityNotes.push(
        'antd-mobile React compatibility (antd-mobile >= 5.40.0 with react >= 19): unstableSetRender and explicit root lifecycle bridging may be required compatibility code; do not flag that pattern by itself.'
      );
    }

    if (capabilityNotes.length > 0) {
      lines.push('');
      lines.push('Compatibility notes:');
      for (const note of capabilityNotes) {
        lines.push(`- ${note}`);
      }
    }

    lines.push('');
  }

  lines.push('Rules:');
  lines.push('- Treat resolved versions as authoritative when present.');
  lines.push(
    '- Do not suggest APIs introduced after these versions unless you explicitly state that an upgrade is required.'
  );
  lines.push('- If exact version is unknown, avoid version-sensitive API rewrite suggestions.');
  lines.push(
    '- Treat compatibility notes as authoritative. Do not flag patterns that are valid for these grounded versions only because older framework conventions differed.'
  );

  return lines.join('\n');
}
