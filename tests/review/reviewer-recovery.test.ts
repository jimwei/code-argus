import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execute, createRuntime } = vi.hoisted(() => ({
  execute: vi.fn(),
  createRuntime: vi.fn(),
}));
vi.mock('../../src/runtime/factory.js', () => ({ createRuntimeFromEnv: createRuntime }));
import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';

const context = {
  repoPath: '.',
  diff: { diff: '+updateAccount()' },
  diffFiles: [
    { path: 'src/auth.ts', type: 'modify', category: 'source', content: '+updateAccount()' },
  ],
  fileAnalyses: [],
  standards: { source: [] },
};
const finding = {
  file: 'src/auth.ts',
  line_start: 10,
  line_end: 10,
  severity: 'error',
  category: 'security',
  title: 'Missing account authorization',
  description: 'The mutation accepts another account ID without checking its owner.',
  confidence: 0.95,
};
const usage = { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 };
function fixture(abortController?: AbortController) {
  return new StreamingReviewOrchestrator({
    reviewStrategy: 'multi',
    skipValidation: true,
    progressMode: 'silent',
    abortController,
  });
}
function run(orchestrator: StreamingReviewOrchestrator) {
  return (orchestrator as any).runAgentsWithStreaming(context, '.', ['logic-reviewer']);
}

beforeEach(() => {
  vi.useFakeTimers();
  execute.mockReset();
  createRuntime.mockReturnValue({
    kind: 'openai-responses',
    config: { models: { main: 'test' } },
    execute,
  });
});
afterEach(() => vi.useRealTimers());

describe('bounded reviewer recovery', () => {
  it.each(['HTTP 503 upstream unavailable', 'HTTP 400 unexpected gateway response'])(
    'recovers from %s within two total attempts',
    async (message) => {
      let attempt = 0;
      execute.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            status: ++attempt === 1 ? 'error' : 'success',
            error: message,
            usage,
          };
        },
        close: vi.fn(),
      }));
      const orchestrator = fixture();
      const pending = run(orchestrator);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await pending).tokens).toBe(24);
      expect(execute).toHaveBeenCalledTimes(2);
      expect((orchestrator as any).getReviewExecutionMetadata().review_complete).toBe(true);
    }
  );

  it('reuses accepted findings after a truncated attempt and carries evidence into the next prompt', async () => {
    let attempt = 0;
    execute.mockImplementation((options) => ({
      async *[Symbol.asyncIterator]() {
        const current = ++attempt;
        if (current === 2) expect(options.prompt).toContain('Previously reported finding');
        await options.tools.find((tool: any) => tool.name === 'report_issue').execute(finding);
        yield {
          type: 'result',
          status: current === 1 ? 'incomplete' : 'success',
          rawStopReason: 'incomplete.max_output_tokens',
          usage,
        };
      },
      close: vi.fn(),
    }));
    const orchestrator = fixture();
    const pending = run(orchestrator);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).tokens).toBe(24);
    expect((orchestrator as any).rawIssuesForSkipMode).toHaveLength(1);
    expect((orchestrator as any).getReviewExecutionMetadata().review_complete).toBe(true);
  });

  it('retains partial findings, all known usage and the reason after exhausting both attempts', async () => {
    execute.mockImplementation((options) => ({
      async *[Symbol.asyncIterator]() {
        await options.tools.find((tool: any) => tool.name === 'report_issue').execute(finding);
        yield { type: 'result', status: 'error', error: 'HTTP 502 broken stream', usage };
      },
      close: vi.fn(),
    }));
    const orchestrator = fixture();
    const pending = run(orchestrator).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error.reviewUsage).toMatchObject({ tokens: 24, cachedInputTokensUsed: 8 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect((orchestrator as any).rawIssuesForSkipMode).toHaveLength(1);
    expect((orchestrator as any).getReviewExecutionMetadata()).toMatchObject({
      review_complete: false,
      incomplete_reasons: [expect.stringContaining('HTTP 502 broken stream')],
    });
  });

  it('stops without another execution when cancelled during backoff', async () => {
    const abortController = new AbortController();
    execute.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', status: 'error', error: '503', usage };
      },
      close: vi.fn(),
    }));
    const orchestrator = fixture(abortController);
    const pending = run(orchestrator).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(100);
    abortController.abort('stop review');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).message).toContain('cancelled during retry backoff');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancelled', 'aborted', 'error_cancelled'])(
    'does not retry an explicit %s runtime result',
    async (status) => {
      execute.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', status, error: 'User cancelled review', usage };
        },
        close: vi.fn(),
      }));
      await expect(run(fixture())).rejects.toThrow('User cancelled review');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('does not start a reviewer when already cancelled', async () => {
    const abortController = new AbortController();
    abortController.abort();
    await expect(run(fixture(abortController))).rejects.toThrow('cancelled');
    expect(execute).not.toHaveBeenCalled();
  });
});
