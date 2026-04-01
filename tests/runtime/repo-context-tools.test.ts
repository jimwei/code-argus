import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepoContextTools } from '../../src/runtime/repo-context-tools.js';

const tempDirs: string[] = [];

async function createTempRepo(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('repo context tools', () => {
  it('provides Read, Grep, and Glob tools for runtime parity', async () => {
    const repoPath = await createTempRepo('argus-repo-tools');
    await mkdir(join(repoPath, 'src', 'components'), { recursive: true });

    await writeFile(
      join(repoPath, 'src', 'components', 'App.tsx'),
      [
        'import { useNavigate } from "react-router-dom";',
        'export function App() {',
        '  return null;',
        '}',
      ].join('\n')
    );
    await writeFile(
      join(repoPath, 'src', 'components', 'App.test.tsx'),
      ['describe("App", () => {', '  it("renders", () => {});', '});'].join('\n')
    );

    const tools = createRepoContextTools(repoPath);
    expect(tools.map((tool) => tool.name)).toEqual(['Read', 'Grep', 'Glob']);

    const readResult = await tools[0]!.execute({
      file_path: 'src/components/App.tsx',
      offset: 1,
      limit: 2,
    });
    expect(readResult.content[0]?.text).toContain('1\timport { useNavigate }');
    expect(readResult.content[0]?.text).toContain('2\texport function App()');

    const grepResult = await tools[1]!.execute({
      pattern: 'useNavigate',
      glob: '**/*.tsx',
    });
    expect(grepResult.content[0]?.text).toContain('src/components/App.tsx:1');

    const globResult = await tools[2]!.execute({
      pattern: '**/*.test.tsx',
    });
    expect(globResult.content[0]?.text).toContain('src/components/App.test.tsx');
  });
});
