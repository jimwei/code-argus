import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEvent, RuntimeExecuteOptions } from '../../src/runtime/types.js';
import type { LoadedCustomAgent } from '../../src/review/custom-agents/types.js';

const { createRuntimeFromEnvMock, executeMock, closeMock } = vi.hoisted(() => ({
  createRuntimeFromEnvMock: vi.fn(),
  executeMock: vi.fn(),
  closeMock: vi.fn(async () => undefined),
}));
vi.mock('../../src/runtime/factory.js', () => ({ createRuntimeFromEnv: createRuntimeFromEnvMock }));
import { executeCustomAgent } from '../../src/review/custom-agents/executor.js';

const agent: LoadedCustomAgent = {
  id: 'custom:supplemental',
  source_file: '/agents/supplemental.yaml',
  name: 'supplemental',
  description: 'Supplemental reviewer',
  prompt: 'Check error handling',
  enabled: true,
};
const usage = { inputTokens: 11, cachedInputTokens: 5, outputTokens: 7 };

function mockExecution(events: RuntimeEvent[], throwAfterEvents = false) {
  executeMock.mockImplementation((options: RuntimeExecuteOptions) => ({
    async *[Symbol.asyncIterator]() {
      await options.tools?.[0]?.execute({
        file: 'src/service.ts',
        line_start: 1,
        line_end: 1,
        title: 'Partial finding',
        description: 'Reported before termination',
        confidence: 0.9,
      });
      for (const event of events) yield event;
      if (throwAfterEvents) throw new Error('stream transport failed');
    },
    close: closeMock,
  }));
}

describe('custom agent incomplete runtime results', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRuntimeFromEnvMock.mockReturnValue({ execute: executeMock });
  });

  it.each(['incomplete', 'error_max_turns'])(
    'propagates %s with partial findings and usage',
    async (status) => {
      mockExecution([
        {
          type: 'result',
          status,
          error: 'Provider stopped early',
          rawStopReason: 'incomplete.max_output_tokens',
          usage,
        },
      ]);
      const onAgentComplete = vi.fn();
      const onAgentError = vi.fn();
      const result = await executeCustomAgent(
        agent,
        { repoPath: '/repo', diffContent: '+changed' },
        { onAgentComplete, onAgentError }
      );
      expect(result.error).toContain(status);
      expect(result.error).toContain('Provider stopped early');
      expect(result.error).toContain('incomplete.max_output_tokens');
      expect(result.issues).toHaveLength(1);
      expect(result).toMatchObject({
        input_tokens_used: 11,
        cached_input_tokens_used: 5,
        output_tokens_used: 7,
        tokens_used: 18,
      });
      expect(onAgentComplete).toHaveBeenCalledWith(agent, result);
      expect(onAgentError).not.toHaveBeenCalled();
      expect(closeMock).toHaveBeenCalledTimes(1);
    }
  );

  it('propagates a fatal error status through the error callback without losing partial usage', async () => {
    mockExecution([
      {
        type: 'result',
        status: 'error',
        error: 'Provider stopped early',
        rawStopReason: 'incomplete.max_output_tokens',
        usage,
      },
    ]);
    const onAgentComplete = vi.fn();
    const onAgentError = vi.fn();
    const result = await executeCustomAgent(
      agent,
      { repoPath: '/repo', diffContent: '+changed' },
      { onAgentComplete, onAgentError }
    );
    expect(result.error).toBe('Provider stopped early: incomplete.max_output_tokens');
    expect(result.issues).toHaveLength(1);
    expect(result).toMatchObject({
      input_tokens_used: 11,
      cached_input_tokens_used: 5,
      output_tokens_used: 7,
      tokens_used: 18,
    });
    expect(onAgentError).toHaveBeenCalledTimes(1);
    expect(onAgentComplete).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('marks a stream without a terminal result as incomplete and preserves findings', async () => {
    mockExecution([{ type: 'assistant.text', text: 'Working...' }]);
    const onAgentComplete = vi.fn();
    const result = await executeCustomAgent(
      agent,
      { repoPath: '/repo', diffContent: '+changed' },
      { onAgentComplete }
    );
    expect(result.error).toMatch(/without.*(?:terminal|result)/i);
    expect(result.issues).toHaveLength(1);
    expect(result.tokens_used).toBe(0);
    expect(onAgentComplete).toHaveBeenCalledWith(agent, result);
  });

  it('keeps successful results clean', async () => {
    mockExecution([{ type: 'result', status: 'success', usage }]);
    const result = await executeCustomAgent(agent, { repoPath: '/repo', diffContent: '+changed' });
    expect(result.error).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.tokens_used).toBe(18);
  });

  it('keeps the onAgentError path for thrown exceptions and retains partial findings and usage', async () => {
    mockExecution([{ type: 'result', status: 'incomplete', usage }], true);
    const onAgentComplete = vi.fn();
    const onAgentError = vi.fn();
    const result = await executeCustomAgent(
      agent,
      { repoPath: '/repo', diffContent: '+changed' },
      { onAgentComplete, onAgentError }
    );
    expect(result.error).toBe('stream transport failed');
    expect(result.issues).toHaveLength(1);
    expect(result.tokens_used).toBe(18);
    expect(onAgentComplete).not.toHaveBeenCalled();
    expect(onAgentError).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({ message: 'stream transport failed' })
    );
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
