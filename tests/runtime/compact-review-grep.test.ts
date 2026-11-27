import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepoContextTools } from '../../src/runtime/repo-context-tools.js';
import { OpenAIResponsesRuntime } from '../../src/runtime/openai-responses.js';

const banner = '[Matches grouped by file; each match uses line<TAB>text]';
const fileA = `src/${'long-directory-'.repeat(7)}日本/a.ts`;
const fileB = `src/${'other-long-'.repeat(8)}測試/a.ts`;
const lines = [
  'NEEDLE "path" \\ text\tindent',
  '',
  'NEEDLE café',
  `NEEDLE ${'🎉'.repeat(100)}`,
  'NEEDLE later',
];
const size = (text: string) => Buffer.byteLength(text, 'utf8');
const dirs: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'argus-compact-grep-'));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function expand(text: string) {
  if (!text.startsWith(`${banner}\n`)) return text;
  let file: string | undefined;
  return text
    .split('\n')
    .slice(1)
    .flatMap((line) => {
      if (line.startsWith('File: ')) {
        file = line.slice(6);
        return [];
      }
      if (/^\d+\t/u.test(line) && file) return [`${file}:${line}`];
      if (line.startsWith('[')) return [line];
      throw new Error('Unrecognized grouped Grep row');
    })
    .join('\n');
}
async function grep(root: string, enabled: boolean, args: object, budget?: number) {
  const tool = createRepoContextTools(root, {
    compactGrepOutput: enabled,
    grepByteLimit: budget,
    grepLineCharLimit: 70,
  }).find((t) => t.name === 'Grep')!;
  return (await tool.execute(args)).content[0]!.text;
}

it('preserves exact matched text, order, line numbers and notes under both original limits', async () => {
  const root = await fixture({
    [fileA]: lines.join('\r\n'),
    [fileB]: lines.join('\n'),
    'ignored.min.js': lines[0]!,
  });
  const limit = size(`${fileA}:1\t${lines[0]}\n${fileA}:3\t${lines[2]}\n`);
  for (const [args, budget] of [
    [{ pattern: 'NEEDLE|^$' }, undefined],
    [{ pattern: 'NEEDLE', path: fileA }, limit],
    [{ pattern: 'NEEDLE', path: fileA, max_results: 2 }, undefined],
  ] as const) {
    const classic = await grep(root, false, args, budget);
    const compact = await grep(root, true, args, budget);
    expect(compact.startsWith(banner)).toBe(true);
    expect(expand(compact)).toBe(classic);
    expect(size(JSON.stringify(compact))).toBeLessThan(size(JSON.stringify(classic)));
    if (budget) expect(compact).toContain(`grep output truncated at ${budget} bytes`);
    if (!('path' in args))
      expect(compact).toContain('1 generated or oversized file(s) were skipped');
  }
});

it('keeps legacy format when hits are empty, grouping is ambiguous, or JSON does not shrink', async () => {
  const odd = `src/${'long-'.repeat(20)}\u2028a.ts`;
  const escapingBoundary = `${'p'.repeat(banner.length + 4)}.ts`;
  const root = await fixture({
    [odd]: 'AMBIGUOUS\nAMBIGUOUS',
    's.ts': 'SHORT\nSHORT',
    [escapingBoundary]: 'ESCAPE\nESCAPE',
  });
  for (const pattern of ['MISSING', 'AMBIGUOUS', 'SHORT', 'ESCAPE']) {
    const classic = await grep(root, false, { pattern });
    expect(await grep(root, true, { pattern })).toBe(classic);
    expect(classic.startsWith(banner)).toBe(false);
  }
  const classic = await grep(root, false, { pattern: 'ESCAPE' });
  const trial = `${banner}\nFile: ${escapingBoundary}\n1\tESCAPE\n2\tESCAPE`;
  expect(size(trial)).toBe(size(classic) - 1);
  expect(size(JSON.stringify(trial))).toBe(size(JSON.stringify(classic)) + 1);
});

it('reduces actual pi-ai replay bytes while keeping the first request, call pairs and result unchanged', async () => {
  const root = await fixture({ [fileA]: lines.join('\n'), [fileB]: lines.join('\n') });
  const url = 'https://argus-compact-grep.invalid/v1';
  const model = 'gpt-6.2-sol';
  const tool = (i: number, name: string, args: object) => ({
    type: 'function_call',
    id: `fc_${i}`,
    call_id: `call_${i}`,
    name,
    arguments: JSON.stringify(args),
  });
  const batches = [
    [tool(1, 'Grep', { pattern: 'NEEDLE' }), tool(2, 'Read', { file_path: fileA, limit: 2 })],
    [tool(3, 'Grep', { pattern: 'NEEDLE', path: fileB })],
    [],
  ];
  const fetch = vi.spyOn(globalThis, 'fetch');
  async function run(compactGrepOutput: boolean) {
    const sent: string[] = [];
    const controller = new AbortController();
    fetch.mockImplementation(async (request, init) => {
      const calls = batches[sent.length];
      if (
        !calls ||
        String(request instanceof globalThis.Request ? request.url : request) !== `${url}/responses`
      ) {
        controller.abort();
        throw new Error('Unexpected offline request');
      }
      sent.push(String(init?.body));
      const events: object[] = [];
      for (const [output_index, item] of calls.entries())
        events.push(
          { type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } },
          { type: 'response.function_call_arguments.delta', output_index, delta: item.arguments },
          { type: 'response.output_item.done', output_index, item }
        );
      if (!calls.length)
        events.push(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
          },
          { type: 'response.output_text.delta', output_index: 0, delta: 'Reviewed.' }
        );
      events.push({
        type: 'response.completed',
        response: {
          id: 'resp_fixture',
          status: 'completed',
          output: calls,
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      });
      return new globalThis.Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const runtime = new OpenAIResponsesRuntime({
      runtime: 'openai-responses',
      models: { main: model, validator: model, light: model },
      reasoningEffort: 'high',
      openai: { apiKey: 'offline-fixture-key', baseUrl: url, source: 'argus' },
    });
    const options = {
      prompt: 'Review the fixture.',
      cwd: root,
      maxTurns: 3,
      tools: createRepoContextTools(root, { compactGrepOutput }),
      abortController: controller,
    };
    const execution = runtime.execute(options);
    const events = [];
    try {
      for await (const e of execution) events.push(e);
    } finally {
      await execution.close();
    }
    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'success' });
    expect(sent).toHaveLength(3);
    return { sent, events };
  }
  const a = await run(false),
    b = await run(true);
  expect(b.sent[0]).toBe(a.sent[0]);
  expect(b.events).toEqual(a.events);
  type Item = { type?: string; call_id?: string; output?: string };
  for (const [i, raw] of b.sent.entries()) {
    const body = JSON.parse(raw) as { input: Item[]; store: boolean };
    expect(body.store).toBe(false);
    expect(body.input.filter((x) => x.type === 'function_call').map((x) => x.call_id)).toEqual(
      body.input.filter((x) => x.type === 'function_call_output').map((x) => x.call_id)
    );
    const stable = body.input.map((x) =>
      x.type === 'function_call_output' ? { ...x, output: expand(x.output!) } : x
    );
    expect({ ...body, input: stable }).toEqual(JSON.parse(a.sent[i]!));
    if (i > 0) expect(size(raw)).toBeLessThan(size(a.sent[i]!));
  }
  const prefix = JSON.parse(b.sent[1]!).input;
  expect(JSON.parse(b.sent[2]!).input.slice(0, prefix.length)).toEqual(prefix);
});
