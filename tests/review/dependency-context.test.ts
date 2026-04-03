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

  it('adds React 19 compatibility notes for ref-as-prop patterns', () => {
    const promptText = formatFrontendDependencyContext({
      snapshots: [
        {
          packageRoot: 'apps/web',
          packageManager: 'pnpm',
          appliesToFiles: ['apps/web/src/App.tsx'],
          dependencies: [
            { name: 'antd-mobile', declaredVersion: '^5.40.0', resolvedVersion: '5.40.0' },
            { name: 'react', declaredVersion: '^19.2.0', resolvedVersion: '19.2.0' },
            { name: 'react-dom', declaredVersion: '^19.2.0', resolvedVersion: '19.2.0' },
          ],
        },
      ],
    });

    expect(promptText).toContain('Compatibility notes');
    expect(promptText).toContain('ref as a regular prop');
    expect(promptText).toContain('do not require forwardRef');
    expect(promptText).toContain('useEffectEvent');
    expect(promptText).toContain('unstableSetRender');
  });

  it('prioritizes framework dependencies when limiting grounded packages', async () => {
    const repoPath = await createTempRepo('argus-deps-priority');
    await mkdir(join(repoPath, 'apps', 'web', 'src'), { recursive: true });

    await writeFile(
      join(repoPath, 'apps', 'web', 'package.json'),
      JSON.stringify(
        {
          name: '@repo/web',
          dependencies: {
            'antd-mobile': '^5.40.0',
            axios: '^1.0.0',
            classnames: '^2.5.1',
            dayjs: '^1.11.0',
            lodash: '^4.17.21',
            react: '^19.2.0',
            'react-dom': '^19.2.0',
            'react-router-dom': '^7.13.0',
            swr: '^2.3.7',
            zustand: '^5.0.0',
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
  apps/web:
    dependencies:
      antd-mobile:
        specifier: ^5.40.0
        version: 5.40.0
      axios:
        specifier: ^1.0.0
        version: 1.0.0
      classnames:
        specifier: ^2.5.1
        version: 2.5.1
      dayjs:
        specifier: ^1.11.0
        version: 1.11.0
      lodash:
        specifier: ^4.17.21
        version: 4.17.21
      react:
        specifier: ^19.2.0
        version: 19.2.0
      react-dom:
        specifier: ^19.2.0
        version: 19.2.0
      react-router-dom:
        specifier: ^7.13.0
        version: 7.13.0
      swr:
        specifier: ^2.3.7
        version: 2.3.7
      zustand:
        specifier: ^5.0.0
        version: 5.0.0
packages: {}
`
    );

    const context = await extractFrontendDependencyContext(repoPath, [
      makeDiffFile(
        'apps/web/src/main.tsx',
        `diff --git a/apps/web/src/main.tsx b/apps/web/src/main.tsx
+import { unstableSetRender } from 'antd-mobile';
+import axios from 'axios';
+import classNames from 'classnames';
+import dayjs from 'dayjs';
+import _ from 'lodash';
+import React from 'react';
+import { createRoot } from 'react-dom/client';
+import { createBrowserRouter } from 'react-router-dom';
+import useSWR from 'swr';
+import { create } from 'zustand';`
      ),
    ]);

    const dependencyNames = context?.snapshots[0]?.dependencies.map(
      (dependency) => dependency.name
    );
    expect(dependencyNames).toContain('antd-mobile');
    expect(dependencyNames).toContain('react');
    expect(dependencyNames).toContain('react-dom');
    expect(dependencyNames).toContain('react-router-dom');
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
