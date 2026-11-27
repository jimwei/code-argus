import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';
import { createStreamingValidator } from '../../src/review/streaming-validator.js';
import type { ReviewContext } from '../../src/review/types.js';
import { OpenAIResponsesRuntime } from '../../src/runtime/openai-responses.js';
import { OpenAIResponsesSdkRuntime } from '../../src/runtime/openai-responses-sdk.js';
import type { AgentRuntime, RuntimeEvent } from '../../src/runtime/types.js';

vi.mock('../../src/config/store.js', () => ({ loadConfig: () => ({}) }));

// The same file produces distinct classic and grouped output for exactly the same hits.
const file = 'review-fixture-with-a-long-name-to-make-grouping-worthwhile.ts';
const lines = Array.from({ length: 4 }, (_, index) => `// grep-fixture ${index + 1}`);
const rows = lines.map((text, index) => `${index + 1}\t${text}`);
const classicOutput = rows.map((row) => `${file}:${row}`).join('\n');
const compactOutput = [
  '[Matches grouped by file; each match uses line<TAB>text]',
  `File: ${file}`,
  ...rows,
].join('\n');
const validatorResponse = JSON.stringify({
  validation_status: 'confirmed',
  final_confidence: 0.95,
  grounding_evidence: {
    checked_files: [file],
    checked_symbols: [],
    related_context: 'Read the fixture.',
    reasoning: 'The line is present.',
  },
});

describe('Grep grouping across the review and validation runtimes', () => {
  let repoPath: string | undefined;
  const observeGrep = vi.fn<(output: string) => void>();
  const execute: AgentRuntime['execute'] = ({ tools }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent> {
      const grep = tools?.find((tool) => tool.name === 'Grep');
      if (!grep) throw new Error('Expected the runtime to receive a Grep tool');
      const result = await grep.execute({ path: file, pattern: 'grep-fixture' });
      observeGrep(result.content.map(({ text }) => text).join('\n'));
      yield { type: 'result', status: 'success', text: validatorResponse };
    },
    close: async () => {},
  });

  beforeEach(async () => {
    vi.stubEnv('ARGUS_RUNTIME', 'openai-responses');
    vi.stubEnv('ARGUS_OPENAI_API_KEY', 'offline-fixture-key');
    vi.stubEnv('ARGUS_OPENAI_MODEL', 'offline-fixture-model');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
    observeGrep.mockClear();
    repoPath = await mkdtemp(join(tmpdir(), 'argus-grep-wiring-'));
    await writeFile(join(repoPath, file), lines.join('\n'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (repoPath) {
      await rm(repoPath, { recursive: true, force: true });
      repoPath = undefined;
    }
  });

  it.each([
    { impl: 'pi-ai', flag: 'true', expected: compactOutput },
    { impl: 'pi-ai', flag: undefined, expected: classicOutput },
    { impl: 'pi-ai', flag: 'false', expected: classicOutput },
    { impl: 'sdk', flag: 'true', expected: classicOutput },
  ])(
    'uses the expected Grep format for a $impl reviewer with flag=$flag',
    async ({ impl, flag, expected }) => {
      vi.stubEnv('ARGUS_OPENAI_RESPONSE_IMPL', impl);
      vi.stubEnv('ARGUS_OPENAI_COMPACT_REVIEW_GREP', flag);
      const piExecute = vi
        .spyOn(OpenAIResponsesRuntime.prototype, 'execute')
        .mockImplementation(execute);
      const sdkExecute = vi
        .spyOn(OpenAIResponsesSdkRuntime.prototype, 'execute')
        .mockImplementation(execute);
      const root = repoPath!;
      const change = `+${lines[0]}`;
      const context: ReviewContext = {
        repoPath: root,
        diff: {
          diff: change,
          repoPath: root,
          sourceBranch: 'feature',
          targetBranch: 'main',
          remote: 'origin',
        },
        diffFiles: [{ path: file, type: 'modify', category: 'source', content: change }],
        fileAnalyses: [],
        standards: { source: [] },
      };
      const orchestrator = new StreamingReviewOrchestrator({
        reviewStrategy: 'multi',
        skipValidation: true,
        progressMode: 'silent',
      });

      await orchestrator['runAgentsWithStreaming'](context, root, ['logic-reviewer']);

      expect(piExecute).toHaveBeenCalledTimes(impl === 'pi-ai' ? 1 : 0);
      expect(sdkExecute).toHaveBeenCalledTimes(impl === 'sdk' ? 1 : 0);
      expect(observeGrep.mock.calls).toEqual([[expected]]);
    }
  );

  it('keeps pi-ai validator Grep ungrouped even with the reviewer flag enabled', async () => {
    vi.stubEnv('ARGUS_OPENAI_RESPONSE_IMPL', 'pi-ai');
    vi.stubEnv('ARGUS_OPENAI_COMPACT_REVIEW_GREP', 'true');
    vi.spyOn(OpenAIResponsesRuntime.prototype, 'execute').mockImplementation(execute);
    const validator = createStreamingValidator({
      repoPath: repoPath!,
      challengeMode: false,
      maxChallengeRounds: 1,
      language: 'en',
    });
    validator.enqueue({
      id: 'grep-fixture-issue',
      file,
      line_start: 1,
      line_end: 1,
      category: 'logic',
      severity: 'warning',
      title: 'Fixture issue',
      description: 'Check the fixture line.',
      confidence: 0.95,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush();

    expect(result.issues).toMatchObject([
      { id: 'grep-fixture-issue', validation_status: 'confirmed' },
    ]);
    expect(observeGrep.mock.calls).toEqual([[classicOutput]]);
  });
});
