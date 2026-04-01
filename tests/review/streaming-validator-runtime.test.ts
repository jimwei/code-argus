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
        tools: expect.any(Array),
      })
    );
    expect(
      executeMock.mock.calls[0]?.[0]?.tools?.map((tool: { name: string }) => tool.name)
    ).toEqual(['Read', 'Grep', 'Glob']);
    expect(queryMock).not.toHaveBeenCalled();

    const runtimeOptions = executeMock.mock.calls[0]?.[0];
    expect(runtimeOptions.prompt).toEqual(
      expect.objectContaining({
        [Symbol.asyncIterator]: expect.any(Function),
      })
    );

    expect(result.inputTokensUsed).toBe(9);
    expect(result.outputTokensUsed).toBe(6);
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

  it('auto-rejects low-signal soft suggestions before opening a runtime session', async () => {
    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      challengeMode: true,
      maxChallengeRounds: 5,
      language: 'en',
    });

    const autoRejected = validator.enqueue({
      id: 'issue-soft-style',
      file: 'src/ui/card.tsx',
      line_start: 12,
      line_end: 14,
      category: 'style',
      severity: 'suggestion',
      title: 'Rename helper for readability',
      description: 'The helper name could be clearer to future readers.',
      suggestion: 'Use a more expressive helper name.',
      confidence: 0.98,
      source_agent: 'style-reviewer',
    });

    expect(autoRejected).toMatchObject({
      id: 'issue-soft-style',
      validation_status: 'rejected',
      rejection_reason: expect.stringContaining('低信号'),
    });

    const result = await validator.flush();

    expect(result.issues).toHaveLength(0);
    expect(result.inputTokensUsed).toBe(0);
    expect(result.outputTokensUsed).toBe(0);
    expect(result.tokensUsed).toBe(0);
    expect(createRuntimeFromEnvMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('uses a stricter validation threshold for style warnings than for logic warnings', async () => {
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
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          const responseText = JSON.stringify({
            validation_status: 'confirmed',
            final_confidence: 0.82,
            grounding_evidence: {
              checked_files: ['src/core/handler.ts'],
              checked_symbols: [],
              related_context: 'Observed the missing null guard in the changed logic path.',
              reasoning: 'The payload is dereferenced before the null branch is handled.',
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
              inputTokens: 8,
              outputTokens: 5,
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

    const styleRejected = validator.enqueue({
      id: 'issue-style-warning',
      file: 'src/ui/card.tsx',
      line_start: 20,
      line_end: 24,
      category: 'style',
      severity: 'warning',
      title: 'Extract nested condition for readability',
      description: 'The nested condition is harder to scan quickly.',
      suggestion: 'Extract the condition into a named helper.',
      confidence: 0.7,
      source_agent: 'style-reviewer',
    });

    const logicAccepted = validator.enqueue({
      id: 'issue-logic-warning',
      file: 'src/core/handler.ts',
      line_start: 40,
      line_end: 45,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The handler dereferences an optional payload.',
      suggestion: 'Guard the null path before reading payload fields.',
      confidence: 0.7,
      source_agent: 'logic-reviewer',
    });

    expect(styleRejected).toMatchObject({
      id: 'issue-style-warning',
      validation_status: 'rejected',
    });
    expect(logicAccepted).toBeNull();

    const result = await validator.flush();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-logic-warning',
      validation_status: 'confirmed',
    });
    expect(createRuntimeFromEnvMock).toHaveBeenCalledTimes(1);
  });
});
