import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createRuntimeFromEnvMock, executeMock, closeMock, queryMock } = vi.hoisted(() => ({
  createRuntimeFromEnvMock: vi.fn(),
  executeMock: vi.fn(),
  closeMock: vi.fn(async () => undefined),
  queryMock: vi.fn(() => {
    throw new Error('query should not be used when runtime abstraction is active');
  }),
}));

vi.mock('../../src/runtime/factory.js', () => ({
  createRuntimeFromEnv: createRuntimeFromEnvMock,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

import { createStreamingValidator } from '../../src/review/streaming-validator.js';

describe('streaming validator runtime bridge', () => {
  beforeEach(() => {
    createRuntimeFromEnvMock.mockReset();
    executeMock.mockReset();
    closeMock.mockClear();
    queryMock.mockClear();
  });

  it('validates queued issues through the runtime abstraction', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      execute: executeMock.mockImplementation((options) => ({
        async *[Symbol.asyncIterator]() {
          const iterator = options.prompt[Symbol.asyncIterator]();
          const firstPrompt = await iterator.next();

          expect(firstPrompt.done).toBe(false);
          expect(firstPrompt.value).toMatchObject({
            type: 'user',
            message: {
              role: 'user',
            },
          });

          const responseText = JSON.stringify({
            validation_status: 'confirmed',
            final_confidence: 0.92,
            grounding_evidence: {
              checked_files: ['src/api/service.ts'],
              checked_symbols: [],
              related_context: 'Observed the new guard in the changed branch.',
              reasoning: 'The null path is now handled before dereferencing the response.',
            },
          });

          yield {
            type: 'assistant.text',
            text: responseText,
          };

          yield {
            type: 'result',
            status: 'success',
            usage: {
              inputTokens: 9,
              outputTokens: 6,
            },
            text: responseText,
          };
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      challengeMode: false,
      maxChallengeRounds: 1,
      language: 'en',
    });

    const autoRejected = validator.enqueue({
      id: 'issue-1',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      suggestion: 'Guard the null path before accessing response fields.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    expect(autoRejected).toBeNull();

    const result = await validator.flush();

    expect(createRuntimeFromEnvMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'C:\\repo',
        model: 'gpt-5.3-codex',
      })
    );
    expect(queryMock).not.toHaveBeenCalled();

    const runtimeOptions = executeMock.mock.calls[0]?.[0];
    expect(runtimeOptions.prompt).toEqual(
      expect.objectContaining({
        [Symbol.asyncIterator]: expect.any(Function),
      })
    );

    expect(result.tokensUsed).toBe(15);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-1',
      validation_status: 'confirmed',
      final_confidence: 0.92,
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('closes the runtime prompt stream after the final queued issue is validated', async () => {
    let secondPromptResult: { done: boolean; value?: unknown | 'timeout' } | undefined;

    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      execute: executeMock.mockImplementation((options) => ({
        async *[Symbol.asyncIterator]() {
          const iterator = options.prompt[Symbol.asyncIterator]();
          const firstPrompt = await iterator.next();

          expect(firstPrompt.done).toBe(false);

          const responseText = JSON.stringify({
            validation_status: 'confirmed',
            final_confidence: 0.92,
            grounding_evidence: {
              checked_files: ['src/api/service.ts'],
              checked_symbols: [],
              related_context: 'Observed the new guard in the changed branch.',
              reasoning: 'The null path is now handled before dereferencing the response.',
            },
          });

          yield {
            type: 'assistant.text',
            text: responseText,
          };

          yield {
            type: 'result',
            status: 'success',
            usage: {
              inputTokens: 9,
              outputTokens: 6,
            },
            text: responseText,
          };

          secondPromptResult = await Promise.race([
            iterator.next(),
            new Promise<{ done: false; value: 'timeout' }>((resolve) =>
              setTimeout(() => resolve({ done: false, value: 'timeout' }), 50)
            ),
          ]);
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      challengeMode: false,
      maxChallengeRounds: 1,
      language: 'en',
    });

    validator.enqueue({
      id: 'issue-1',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      suggestion: 'Guard the null path before accessing response fields.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush(500);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-1',
      validation_status: 'confirmed',
    });
    expect(secondPromptResult).toEqual({ done: true, value: undefined });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
