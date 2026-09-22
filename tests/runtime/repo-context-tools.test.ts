import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRepoContextTools } from '../../src/runtime/repo-context-tools.js';

const minimatchCompilations = vi.hoisted(() => ({ total: 0, exclusion: 0 }));

vi.mock('minimatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('minimatch')>();

  class CountingMinimatch extends actual.Minimatch {
    constructor(...args: ConstructorParameters<typeof actual.Minimatch>) {
      minimatchCompilations.total += 1;
      const [pattern] = args;
      if (typeof pattern === 'string' && pattern.includes('iconfont.js')) {
        minimatchCompilations.exclusion += 1;
      }
      super(...args);
    }
  }

  return { ...actual, Minimatch: CountingMinimatch };
});

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

  it('defaults Read to an issue-focused window when focus options match the file', async () => {
    const repoPath = await createTempRepo('argus-repo-focused-read');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(
      join(repoPath, 'src', 'large.ts'),
      Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join('\n')
    );

    const tools = createRepoContextTools(repoPath, {
      defaultReadLimit: 100,
      maxReadLimit: 50,
      focusedReadWindow: {
        filePath: 'src/large.ts',
        lineStart: 60,
        lineEnd: 62,
        contextLines: 5,
      },
    });

    const focusedRead = await tools[0]!.execute({
      file_path: 'src/large.ts',
    });
    expect(focusedRead.content[0]?.text).toContain('Lines: 55-67');
    expect(focusedRead.content[0]?.text).toContain('55\tline 55');
    expect(focusedRead.content[0]?.text).toContain('67\tline 67');
    expect(focusedRead.content[0]?.text).not.toContain('54\tline 54');

    const explicitRead = await tools[0]!.execute({
      file_path: 'src/large.ts',
      offset: 1,
      limit: 2,
    });
    expect(explicitRead.content[0]?.text).toContain('Lines: 1-2');
  });

  it('caps Read output at the byte budget and reports where to continue', async () => {
    const repoPath = await createTempRepo('argus-repo-read-byte-cap');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(
      join(repoPath, 'src', 'wide.ts'),
      Array.from({ length: 200 }, (_, index) => `line ${index + 1} ${'x'.repeat(200)}`).join('\n')
    );

    const tools = createRepoContextTools(repoPath, { readByteLimit: 2048 });
    const text = (await tools[0]!.execute({ file_path: 'src/wide.ts' })).content[0]?.text ?? '';

    expect(text).toContain('truncated');
    expect(text).toMatch(/offset=\d+/);
    expect(text).not.toContain('line 200');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(4096);
  });

  it('clips a single oversized Read line instead of returning it whole', async () => {
    const repoPath = await createTempRepo('argus-repo-read-long-line');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src', 'minified.js'), `const a = "${'y'.repeat(200000)}";`);

    const tools = createRepoContextTools(repoPath, { readByteLimit: 4096 });
    const text = (await tools[0]!.execute({ file_path: 'src/minified.js' })).content[0]?.text ?? '';

    expect(text).toContain('truncated');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(8192);
  });

  it('truncates long Grep match lines and caps the total Grep payload', async () => {
    const repoPath = await createTempRepo('argus-repo-grep-byte-cap');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src', 'bundle.js'), `NEEDLE ${'y'.repeat(40000)}`);
    await writeFile(join(repoPath, 'src', 'app.ts'), 'const NEEDLE = 1;');

    const tools = createRepoContextTools(repoPath, {
      grepByteLimit: 2048,
      grepLineCharLimit: 200,
    });
    const text = (await tools[1]!.execute({ pattern: 'NEEDLE' })).content[0]?.text ?? '';

    expect(text).toContain('src/app.ts:1');
    expect(text).toContain('src/bundle.js:1');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(4096);

    const bundleLine = text.split('\n').find((line) => line.startsWith('src/bundle.js:1')) ?? '';
    expect(bundleLine.length).toBeLessThan(400);
  });

  it('stops Grep output once the byte budget is exhausted', async () => {
    const repoPath = await createTempRepo('argus-repo-grep-stop');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(
      join(repoPath, 'src', 'many.ts'),
      Array.from({ length: 500 }, (_, index) => `match ${index + 1} ${'z'.repeat(200)}`).join('\n')
    );

    const tools = createRepoContextTools(repoPath, { grepByteLimit: 2048 });
    const text = (await tools[1]!.execute({ pattern: 'match' })).content[0]?.text ?? '';

    expect(text).toContain('truncated');
    expect(text).not.toContain('match 500');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(4096);
  });

  it('skips generated and oversized files during Grep and Glob by default', async () => {
    const repoPath = await createTempRepo('argus-repo-exclusions');
    await mkdir(join(repoPath, 'public'), { recursive: true });
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'public', 'iconfont.js'), `TOKEN_NEEDLE ${'g'.repeat(5000)}`);
    await writeFile(
      join(repoPath, 'src', 'huge-data.ts'),
      `TOKEN_NEEDLE ${'h'.repeat(2 * 1024 * 1024)}`
    );
    await writeFile(join(repoPath, 'src', 'app.ts'), 'const TOKEN_NEEDLE = 1;');

    const tools = createRepoContextTools(repoPath);

    const grepText = (await tools[1]!.execute({ pattern: 'TOKEN_NEEDLE' })).content[0]?.text ?? '';
    expect(grepText).toContain('src/app.ts:1');
    expect(grepText).not.toContain('iconfont.js');
    expect(grepText).not.toContain('huge-data.ts');

    const globText = (await tools[2]!.execute({ pattern: '**/*' })).content[0]?.text ?? '';
    expect(globText).toContain('src/app.ts');
    expect(globText).not.toContain('iconfont.js');
    expect(globText).not.toContain('huge-data.ts');
  });

  it('still reads an excluded file when the path is requested explicitly', async () => {
    const repoPath = await createTempRepo('argus-repo-explicit-read');
    await mkdir(join(repoPath, 'public'), { recursive: true });
    await writeFile(join(repoPath, 'public', 'iconfont.js'), `const icon = "${'i'.repeat(5000)}";`);

    const tools = createRepoContextTools(repoPath, { readByteLimit: 4096 });
    const text =
      (await tools[0]!.execute({ file_path: 'public/iconfont.js' })).content[0]?.text ?? '';

    expect(text).toContain('Lines: 1-');
    expect(text).toContain('excluded');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(8192);
  });

  it('reports skipped files instead of silently reporting no matches', async () => {
    const repoPath = await createTempRepo('argus-repo-skip-notice');
    await mkdir(join(repoPath, 'public'), { recursive: true });
    await writeFile(join(repoPath, 'public', 'iconfont.js'), 'ICON_GLYPH_TOKEN = 1;');

    const tools = createRepoContextTools(repoPath);

    const grepText =
      (await tools[1]!.execute({ pattern: 'ICON_GLYPH_TOKEN', glob: '**/iconfont.js' })).content[0]
        ?.text ?? '';
    expect(grepText).toContain('No matches found.');
    expect(grepText).toContain('skipped');

    const globText = (await tools[2]!.execute({ pattern: 'public/**' })).content[0]?.text ?? '';
    expect(globText).toContain('No files matched');
    expect(globText).toContain('skipped');
  });

  it('reports truncation when the byte budget blocks the first match', async () => {
    const repoPath = await createTempRepo('argus-repo-grep-first-match');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src', 'one.js'), `NEEDLE ${'q'.repeat(4000)}`);

    const tools = createRepoContextTools(repoPath, {
      grepByteLimit: 512,
      grepLineCharLimit: 4000,
    });
    const text = (await tools[1]!.execute({ pattern: 'NEEDLE' })).content[0]?.text ?? '';

    expect(text).toContain('truncated');
    expect(text).toContain('No matches found.');
  });

  it('clips multibyte Read lines on a code point boundary', async () => {
    const repoPath = await createTempRepo('argus-repo-multibyte');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src', 'jp.ts'), 'あ'.repeat(400));

    const tools = createRepoContextTools(repoPath, { readByteLimit: 101 });
    const text = (await tools[0]!.execute({ file_path: 'src/jp.ts' })).content[0]?.text ?? '';

    expect(text).toContain('[line clipped]');
    expect(text).not.toContain('\uFFFD');
  });

  it('reports the continuation offset after clipping an oversized line', async () => {
    const repoPath = await createTempRepo('argus-repo-clip-continue');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src', 'bundle.ts'), `${'z'.repeat(9000)}\nconst tail = 1;\n`);

    const tools = createRepoContextTools(repoPath, { readByteLimit: 2048 });
    const text = (await tools[0]!.execute({ file_path: 'src/bundle.ts' })).content[0]?.text ?? '';

    expect(text).toContain('[line clipped]');
    expect(text).toContain('offset=2');
  });

  it('keeps indexing files that stay under the 1 MB retrieval limit', async () => {
    const repoPath = await createTempRepo('argus-repo-under-limit');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(
      join(repoPath, 'src', 'big-but-searchable.ts'),
      `LIMIT_NEEDLE ${'k'.repeat(900 * 1024)}`
    );

    const tools = createRepoContextTools(repoPath);
    const text = (await tools[1]!.execute({ pattern: 'LIMIT_NEEDLE' })).content[0]?.text ?? '';

    expect(text).toContain('src/big-but-searchable.ts:1');
    expect(text).not.toContain('were skipped during scanning');
  });

  it('compiles the exclusion patterns once per tool instance instead of once per file', async () => {
    const repoPath = await createTempRepo('argus-repo-exclusion-compile');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await mkdir(join(repoPath, 'public'), { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(repoPath, 'src', `file${index}.ts`), `export const value${index} = 1;`);
    }
    await writeFile(join(repoPath, 'public', 'iconfont.js'), 'ICON_GLYPH = 1;');

    minimatchCompilations.total = 0;
    minimatchCompilations.exclusion = 0;

    const tools = createRepoContextTools(repoPath);
    await tools[2]!.execute({ pattern: '**/*.ts' });

    // 1 exclusion pattern + 1 caller glob; a per-file regression would be ~13.
    expect(minimatchCompilations.exclusion).toBe(1);
    expect(minimatchCompilations.total).toBeLessThan(4);
  });

  it('does not split surrogate pairs when truncating Grep match lines', async () => {
    const repoPath = await createTempRepo('argus-repo-surrogates');
    await mkdir(join(repoPath, 'src'), { recursive: true });
    await writeFile(join(repoPath, 'src', 'emoji.ts'), `NEEDLE ${'🎉'.repeat(60)}`);

    const tools = createRepoContextTools(repoPath, { grepLineCharLimit: 20 });
    const text = (await tools[1]!.execute({ pattern: 'NEEDLE' })).content[0]?.text ?? '';

    expect(text).toContain('NEEDLE');
    expect(text).toMatch(/\[\+\d+ chars\]/);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(text)).toBe(false);
  });
});
