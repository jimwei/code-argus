import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import type { DiffFile } from '../../src/git/parser.js';
import {
  extractFrontendDependencyContext,
  formatFrontendDependencyContext,
} from '../../src/review/dependency-context/extractor.js';

const tempDirs: string[] = [];

async function createTempRepo(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

function makeDiffFile(path: string, content: string): DiffFile {
  return {
    path,
    type: 'modify',
    category: 'source',
    content,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('frontend dependency context extraction', () => {
  it('extracts declared and resolved versions for the nearest npm package root', async () => {
    const repoPath = await createTempRepo('argus-deps-npm');
    await mkdir(join(repoPath, 'packages', 'web', 'src'), { recursive: true });

    await writeFile(
      join(repoPath, 'packages', 'web', 'package.json'),
      JSON.stringify(
        {
          name: '@repo/web',
          dependencies: {
            react: '^18.3.1',
            'react-router-dom': '^7.10.1',
            swr: '^2.3.7',
          },
        },
        null,
        2
      )
    );

    await writeFile(
      join(repoPath, 'packages', 'web', 'package-lock.json'),
      JSON.stringify(
        {
          name: '@repo/web',
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: {
                react: '^18.3.1',
                'react-router-dom': '^7.10.1',
                swr: '^2.3.7',
              },
            },
            'node_modules/react': { version: '18.3.1' },
            'node_modules/react-router-dom': { version: '7.10.1' },
            'node_modules/swr': { version: '2.3.7' },
          },
        },
        null,
        2
      )
    );

    const context = await extractFrontendDependencyContext(repoPath, [
      makeDiffFile(
        'packages/web/src/App.tsx',
        `diff --git a/packages/web/src/App.tsx b/packages/web/src/App.tsx
+import { useNavigate } from 'react-router-dom';
+import useSWR from 'swr';
+import { useEffect } from 'react';`
      ),
    ]);

    expect(context).toBeTruthy();
    expect(context?.snapshots).toHaveLength(1);
    expect(context?.snapshots[0]).toMatchObject({
      packageRoot: 'packages/web',
      packageManager: 'npm',
    });
    expect(context?.snapshots[0]?.dependencies).toEqual([
      { name: 'react', declaredVersion: '^18.3.1', resolvedVersion: '18.3.1' },
      { name: 'react-router-dom', declaredVersion: '^7.10.1', resolvedVersion: '7.10.1' },
      { name: 'swr', declaredVersion: '^2.3.7', resolvedVersion: '2.3.7' },
    ]);

    expect(formatFrontendDependencyContext(context!)).toContain('Frontend Dependency Versions');
    expect(formatFrontendDependencyContext(context!)).toContain('react-router-dom');
    expect(formatFrontendDependencyContext(context!)).toContain(
      'Treat resolved versions as authoritative'
    );
  });

  it('extracts resolved versions from pnpm lock importers for nested workspaces', async () => {
    const repoPath = await createTempRepo('argus-deps-pnpm');
    await mkdir(join(repoPath, 'packages', 'web', 'src'), { recursive: true });

    await writeFile(
      join(repoPath, 'packages', 'web', 'package.json'),
      JSON.stringify(
        {
          name: '@repo/web',
          dependencies: {
            react: '^18.3.1',
            'react-router-dom': '^7.10.1',
          },
        },
        null,
        2
      )
    );

    await writeFile(
      join(repoPath, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'
importers:
  .: {}
  packages/web:
    dependencies:
      react:
        specifier: ^18.3.1
        version: 18.3.1
      react-router-dom:
        specifier: ^7.10.1
        version: 7.10.1(react-dom@18.3.1)(react@18.3.1)
packages: {}
`
    );

    const context = await extractFrontendDependencyContext(repoPath, [
      makeDiffFile(
        'packages/web/src/routes.tsx',
        `diff --git a/packages/web/src/routes.tsx b/packages/web/src/routes.tsx
+import { createBrowserRouter } from 'react-router-dom';`
      ),
    ]);

    expect(context?.snapshots[0]?.packageManager).toBe('pnpm');
    expect(context?.snapshots[0]?.dependencies).toEqual([
      { name: 'react', declaredVersion: '^18.3.1', resolvedVersion: '18.3.1' },
      { name: 'react-router-dom', declaredVersion: '^7.10.1', resolvedVersion: '7.10.1' },
    ]);
  });

  it('falls back to declared versions when no exact lock resolution is available', async () => {
    const repoPath = await createTempRepo('argus-deps-declared');
    await mkdir(join(repoPath, 'src'), { recursive: true });

    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify(
        {
          name: 'frontend-app',
          dependencies: {
            vue: '^3.5.13',
            pinia: '^2.3.1',
          },
        },
        null,
        2
      )
    );

    const context = await extractFrontendDependencyContext(repoPath, [
      makeDiffFile(
        'src/App.vue',
        `diff --git a/src/App.vue b/src/App.vue
+import { defineComponent } from 'vue';
+import { defineStore } from 'pinia';`
      ),
    ]);

    expect(context?.snapshots[0]?.dependencies).toEqual([
      { name: 'pinia', declaredVersion: '^2.3.1', resolvedVersion: undefined },
      { name: 'vue', declaredVersion: '^3.5.13', resolvedVersion: undefined },
    ]);

    const promptText = formatFrontendDependencyContext(context!);
    expect(promptText).toContain('exact version unknown');
  });

  it('returns no dependency context for non-frontend diffs', async () => {
    const repoPath = await createTempRepo('argus-deps-none');
    await mkdir(join(repoPath, 'src'), { recursive: true });

    await writeFile(
      join(repoPath, 'package.json'),
      JSON.stringify(
        {
          name: 'backend-app',
          dependencies: {
            express: '^4.21.2',
          },
        },
        null,
        2
      )
    );

    const context = await extractFrontendDependencyContext(repoPath, [
      makeDiffFile(
        'src/server.ts',
        `diff --git a/src/server.ts b/src/server.ts
+import express from 'express';`
      ),
    ]);

    expect(context).toBeUndefined();
  });
});
