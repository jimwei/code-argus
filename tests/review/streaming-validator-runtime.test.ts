import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const tempDirs: string[] = [];
  beforeEach(() => {
    createRuntimeFromEnvMock.mockReset();
    executeMock.mockReset();
    closeMock.mockClear();
    queryMock.mockClear();
  });
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
          expect(firstPrompt.value.message.content).toContain('Frontend Dependency Versions');
          expect(firstPrompt.value.message.content).toContain('react-router-dom');
          expect(firstPrompt.value.message.content).toContain(
            'Reject version-sensitive suggestions that exceed these grounded versions'
          );
          expect(firstPrompt.value.message.content).toContain('ref as a regular prop');
          expect(firstPrompt.value.message.content).toContain('compatibility notes');

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
      dependencyContext: {
        snapshots: [
          {
            packageRoot: '.',
            packageManager: 'npm',
            appliesToFiles: ['src/api/service.ts'],
            dependencies: [
              {
                name: 'react',
                declaredVersion: '^19.2.0',
                resolvedVersion: '19.2.0',
              },
              {
                name: 'react-router-dom',
                declaredVersion: '^7.10.1',
                resolvedVersion: '7.10.1',
              },
            ],
          },
        ],
      },
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
    expect(runtimeOptions).not.toHaveProperty('completionBudget');
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

  it('honours an explicit per-issue validation turn budget', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
        openai: { apiKey: 'openai-key', source: 'argus' },
      },
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          const responseText = JSON.stringify({
            validation_status: 'confirmed',
            final_confidence: 0.9,
            grounding_evidence: {
              checked_files: [],
              checked_symbols: [],
              related_context: 'ok',
              reasoning: 'ok',
            },
          });
          yield { type: 'assistant.text', text: responseText };
          yield {
            type: 'result',
            status: 'success',
            usage: { inputTokens: 1, outputTokens: 1 },
            text: responseText,
          };
        },
        close: closeMock,
      })),
    });

    const issue = {
      id: 'issue-budget',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic' as const,
      severity: 'warning' as const,
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer' as const,
    };

    const tuned = createStreamingValidator({
      repoPath: 'C:\\repo',
      maxTurns: 15,
      maxChallengeRounds: 1,
      language: 'en',
    });
    tuned.enqueue(issue);
    await tuned.flush();

    const defaults = createStreamingValidator({
      repoPath: 'C:\\repo',
      maxChallengeRounds: 1,
      language: 'en',
    });
    defaults.enqueue({ ...issue, id: 'issue-default-budget' });
    await defaults.flush();

    expect(executeMock.mock.calls[0]?.[0]?.maxTurns).toBe(15);
    expect(executeMock.mock.calls[1]?.[0]?.maxTurns).toBe(30);
  });

  it('honours the configurable validator Read window', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'argus-validator-read-'));
    tempDirs.push(repoPath);
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`);
    await writeFile(join(repoPath, 'other.ts'), lines.join('\n'));
    await writeFile(join(repoPath, 'big.ts'), lines.join('\n'));

    const readSamples: string[] = [];
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
        openai: { apiKey: 'openai-key', source: 'argus' },
      },
      execute: executeMock.mockImplementation((options: any) => ({
        async *[Symbol.asyncIterator]() {
          const readTool = options.tools.find((tool: { name: string }) => tool.name === 'Read');
          const sample = await readTool.execute({ file_path: 'other.ts' });
          readSamples.push(sample.content[0]?.text ?? '');
          const responseText = JSON.stringify({
            validation_status: 'confirmed',
            final_confidence: 0.9,
            grounding_evidence: {
              checked_files: [],
              checked_symbols: [],
              related_context: 'ok',
              reasoning: 'ok',
            },
          });
          yield { type: 'assistant.text', text: responseText };
          yield {
            type: 'result',
            status: 'success',
            usage: { inputTokens: 1, outputTokens: 1 },
            text: responseText,
          };
        },
        close: closeMock,
      })),
    });

    const issue = {
      id: 'issue-read-window',
      file: 'big.ts',
      line_start: 10,
      line_end: 12,
      category: 'logic' as const,
      severity: 'warning' as const,
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer' as const,
    };

    const wide = createStreamingValidator({
      repoPath,
      maxChallengeRounds: 1,
      readLimit: 400,
      language: 'en',
    });
    wide.enqueue(issue);
    await wide.flush();

    const defaults = createStreamingValidator({
      repoPath,
      maxChallengeRounds: 1,
      language: 'en',
    });
    defaults.enqueue({ ...issue, id: 'issue-read-window-default' });
    await defaults.flush();

    expect(readSamples[0]).toContain('Lines: 1-400');
    expect(readSamples[1]).toContain('Lines: 1-140');
  });

  it('records an incomplete reason when the validation budget cuts a finding short', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
        openai: { apiKey: 'openai-key', source: 'argus' },
      },
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', status: 'error_max_turns' };
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      maxTurns: 15,
      maxChallengeRounds: 1,
      language: 'en',
    });
    validator.enqueue({
      id: 'issue-budget-cut',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush();

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.validation_status).toBe('uncertain');
    expect(result.incompleteReasons.join(' ')).toContain('Missing null guard');
    expect(result.incompleteReasons.join(' ')).toMatch(/budget exhausted/i);
  });

  it('records incomplete for a non-success status without keyword error text', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
        openai: { apiKey: 'openai-key', source: 'argus' },
      },
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            status: 'incomplete',
            rawStopReason: 'incomplete.max_output_tokens',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      maxTurns: 20,
      maxChallengeRounds: 1,
      language: 'en',
    });
    validator.enqueue({
      id: 'issue-incomplete-status',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush();

    expect(result.incompleteReasons.join(' ')).toContain('incomplete.max_output_tokens');
    expect(result.issues[0]?.validation_status).toBe('uncertain');
  });

  it('drains queued issues when a claude-agent session ends early', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'claude-agent',
      config: {
        runtime: 'claude-agent',
        models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
      },
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            status: 'error_max_turns',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      maxTurns: 15,
      maxChallengeRounds: 1,
      language: 'en',
    });
    const baseIssue = {
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic' as const,
      severity: 'warning' as const,
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer' as const,
    };
    validator.enqueue({ ...baseIssue, id: 'issue-claude-1' });
    validator.enqueue({ ...baseIssue, id: 'issue-claude-2', line_start: 30, line_end: 32 });

    const result = await validator.flush();

    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((issue) => issue.validation_status === 'uncertain')).toBe(true);
    expect(result.incompleteReasons.join(' ')).toMatch(/turn budget exhausted/i);
    expect(result.incompleteReasons.join(' ')).toMatch(/queued issue/i);
  });

  it('records incomplete when flush times out with active sessions', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
        openai: { apiKey: 'openai-key', source: 'argus' },
      },
      execute: executeMock.mockImplementation(() => ({
        // eslint-disable-next-line require-yield -- hanging stream used to force a flush timeout
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      maxTurns: 20,
      maxChallengeRounds: 1,
      language: 'en',
    });
    validator.enqueue({
      id: 'issue-flush-timeout',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush(50);

    expect(result.incompleteReasons.join(' ')).toMatch(/flush timed out/i);
  });

  it('starts a fresh OpenAI validator execution for each queued issue in the same file', async () => {
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
      execute: executeMock
        .mockImplementationOnce((options) => ({
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
            expect(firstPrompt.value.message.content).toContain('issue-1');
            expect(firstPrompt.value.message.content).toContain('Missing null guard');
            expect(firstPrompt.value.message.content).not.toContain('issue-2');

            const responseText = JSON.stringify({
              validation_status: 'confirmed',
              final_confidence: 0.91,
              grounding_evidence: {
                checked_files: ['src/api/service.ts'],
                checked_symbols: [],
                related_context: 'Observed the missing guard.',
                reasoning: 'The nullable payload is dereferenced immediately.',
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
                inputTokens: 7,
                outputTokens: 4,
              },
              text: responseText,
            };
          },
          close: closeMock,
        }))
        .mockImplementationOnce((options) => ({
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
            expect(firstPrompt.value.message.content).toContain('issue-2');
            expect(firstPrompt.value.message.content).toContain('Missing fallback');
            expect(firstPrompt.value.message.content).not.toContain('issue-1');

            const responseText = JSON.stringify({
              validation_status: 'rejected',
              final_confidence: 0.73,
              grounding_evidence: {
                checked_files: ['src/api/service.ts'],
                checked_symbols: [],
                related_context: 'Fallback already exists.',
                reasoning: 'The null branch is handled before the call site.',
              },
              rejection_reason: 'Guard already exists.',
            });

            yield {
              type: 'assistant.text',
              text: responseText,
            };

            yield {
              type: 'result',
              status: 'success',
              usage: {
                inputTokens: 6,
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

    validator.enqueue({
      id: 'issue-2',
      file: 'src/api/service.ts',
      line_start: 28,
      line_end: 31,
      category: 'logic',
      severity: 'warning',
      title: 'Missing fallback',
      description: 'The helper returns undefined without a fallback.',
      suggestion: 'Return a default object when the response is empty.',
      confidence: 0.86,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush();

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(2);
    expect(result.inputTokensUsed).toBe(13);
    expect(result.outputTokensUsed).toBe(9);
    expect(result.tokensUsed).toBe(22);
    expect(result.issues).toHaveLength(2);
    expect(result.issues).toEqual([
      expect.objectContaining({
        id: 'issue-1',
        validation_status: 'confirmed',
        final_confidence: 0.91,
      }),
      expect.objectContaining({
        id: 'issue-2',
        validation_status: 'rejected',
        final_confidence: 0.73,
      }),
    ]);
  });

  it('uses focused repo read tools for OpenAI validator executions', async () => {
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
          const readTool = options.tools.find((tool: { name: string }) => tool.name === 'Read');
          expect(readTool.description).toContain('src/api/service.ts');
          expect(readTool.description).toContain('42-45');

          const responseText = JSON.stringify({
            validation_status: 'confirmed',
            final_confidence: 0.9,
            grounding_evidence: {
              checked_files: ['src/api/service.ts'],
              checked_symbols: [],
              related_context: 'Focused read window was enough.',
              reasoning: 'The issue line range is grounded.',
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
              inputTokens: 5,
              outputTokens: 4,
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

    validator.enqueue({
      id: 'issue-focused-read',
      file: 'src/api/service.ts',
      line_start: 42,
      line_end: 45,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush();

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-focused-read',
      validation_status: 'confirmed',
    });
  });

  it('marks OpenAI validator context-limit failures uncertain without retrying', async () => {
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
      execute: executeMock
        .mockImplementationOnce(() => ({
          [Symbol.asyncIterator]() {
            return {
              async next() {
                const error = new Error('context_length_exceeded: prompt is too large');
                (error as Error & { status: number }).status = 400;
                throw error;
              },
            };
          },
          close: closeMock,
        }))
        .mockImplementationOnce(() => ({
          async *[Symbol.asyncIterator]() {
            const responseText = JSON.stringify({
              validation_status: 'confirmed',
              final_confidence: 0.89,
              grounding_evidence: {
                checked_files: ['src/api/service.ts'],
                checked_symbols: [],
                related_context: 'The second issue still ran.',
                reasoning: 'The runtime continued after the oversized issue.',
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
                inputTokens: 6,
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
      challengeMode: true,
      maxChallengeRounds: 5,
      language: 'en',
    });

    validator.enqueue({
      id: 'issue-too-large',
      file: 'src/api/service.ts',
      line_start: 10,
      line_end: 12,
      category: 'logic',
      severity: 'error',
      title: 'Oversized validation context',
      description: 'The issue requires too much context.',
      code_snippet: 'x'.repeat(20000),
      confidence: 0.9,
      source_agent: 'logic-reviewer',
    });

    validator.enqueue({
      id: 'issue-after-large',
      file: 'src/api/service.ts',
      line_start: 20,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush();

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-too-large',
      validation_status: 'uncertain',
      grounding_evidence: {
        related_context: expect.stringContaining('context_length_exceeded'),
      },
    });
    expect(result.issues[1]).toMatchObject({
      id: 'issue-after-large',
      validation_status: 'confirmed',
    });
  });

  it('treats a bare 413 result event as a validation context-limit failure', async () => {
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
      execute: executeMock.mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {
          const firstRoundText = JSON.stringify({
            validation_status: 'confirmed',
            final_confidence: 0.9,
            grounding_evidence: {
              checked_files: ['src/api/service.ts'],
              checked_symbols: [],
              related_context: 'Observed the guard before the provider error.',
              reasoning: 'The challenge turn then overflowed the request body.',
            },
          });

          yield {
            type: 'assistant.text',
            text: firstRoundText,
          };
          yield {
            type: 'result',
            status: 'success',
            usage: {
              inputTokens: 6,
              outputTokens: 5,
            },
            text: firstRoundText,
          };

          // 挑战回合里上游返回 413：sdk 运行时把 provider 错误转成 result 事件，
          // error.status 不再传到调用方，只剩 openai-node 的固定文案。
          yield {
            type: 'result',
            status: 'error',
            error: '413 status code (no body)',
          };
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      challengeMode: true,
      maxChallengeRounds: 5,
      language: 'en',
    });

    validator.enqueue({
      id: 'issue-413',
      file: 'src/api/service.ts',
      line_start: 10,
      line_end: 12,
      category: 'logic',
      severity: 'error',
      title: 'Oversized validation context',
      description: 'The challenge turn overflows the request body.',
      confidence: 0.9,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush();

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-413',
      validation_status: 'uncertain',
      grounding_evidence: {
        related_context: expect.stringContaining('413 status code (no body)'),
      },
    });
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

  it('rejects issues without a usable file path and marks validation incomplete', async () => {
    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      challengeMode: true,
      maxChallengeRounds: 5,
      language: 'en',
    });

    const rejected = validator.enqueue({
      id: 'issue-missing-file',
      file: undefined as unknown as string,
      line_start: 310,
      line_end: 310,
      category: 'logic',
      severity: 'warning',
      title: 'Missing file path',
      description: 'The finding cannot be grounded without a source file.',
      confidence: 0.9,
      source_agent: 'logic-reviewer',
    });

    expect(rejected).toMatchObject({
      id: 'issue-missing-file',
      validation_status: 'uncertain',
      grounding_evidence: {
        reasoning: expect.stringMatching(/missing file path/i),
      },
    });

    const result = await validator.flush();

    expect(result.issues).toHaveLength(0);
    expect(result.incompleteReasons.join(' ')).toMatch(/missing file path/i);
    expect(createRuntimeFromEnvMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
    expect(validator.getStats()).toEqual({
      completed: 1,
      total: 1,
      activeSessions: 0,
    });
  });

  it('records incomplete after a validator session exhausts crash retries', async () => {
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
      execute: executeMock.mockImplementation(() => {
        throw new Error('validator crashed');
      }),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      challengeMode: false,
      maxChallengeRounds: 1,
      language: 'en',
    });

    validator.enqueue({
      id: 'issue-crash',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush(500);

    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-crash',
      validation_status: 'uncertain',
      grounding_evidence: {
        reasoning: expect.stringMatching(/maximum retries/i),
      },
    });
    expect(result.incompleteReasons.join(' ')).toMatch(/session crashed after maximum retries/i);
  });

  it('records incomplete when a crash interrupts a challenge after a response', async () => {
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
            final_confidence: 0.9,
            grounding_evidence: {
              checked_files: ['src/api/service.ts'],
              checked_symbols: [],
              related_context: 'First challenge round completed.',
              reasoning: 'The initial response was confirmed.',
            },
          });
          yield { type: 'assistant.text', text: responseText };
          yield {
            type: 'result',
            status: 'success',
            usage: { inputTokens: 1, outputTokens: 1 },
            text: responseText,
          };
          throw new Error('crashed before challenge round');
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      challengeMode: true,
      maxChallengeRounds: 2,
      language: 'en',
    });

    validator.enqueue({
      id: 'issue-interrupted-challenge',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The challenge round is interrupted by a runtime crash.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush(500);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-interrupted-challenge',
      validation_status: 'confirmed',
    });
    expect(result.incompleteReasons.join(' ')).toMatch(/crashed before completing/i);
  });

  it('starts a fresh session for a late issue after the previous session closed', async () => {
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
            final_confidence: 0.9,
            grounding_evidence: {
              checked_files: ['src/api/service.ts'],
              checked_symbols: [],
              related_context: 'Late issue validated in a fresh session.',
              reasoning: 'The new session accepted the issue.',
            },
          });
          yield { type: 'assistant.text', text: responseText };
          yield {
            type: 'result',
            status: 'success',
            usage: { inputTokens: 1, outputTokens: 1 },
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

    const priorResult = {
      id: 'prior-issue',
      file: 'src/api/service.ts',
      line_start: 10,
      line_end: 10,
      category: 'logic',
      severity: 'warning',
      title: 'Prior issue',
      description: 'A result that was already collected.',
      confidence: 0.8,
      source_agent: 'logic-reviewer',
      validation_status: 'uncertain',
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: 'prior',
        reasoning: 'prior',
      },
      final_confidence: 0.4,
    };

    const sessions = (
      validator as unknown as {
        sessions: Map<
          string,
          {
            file: string;
            queue: unknown[];
            isProcessing: boolean;
            isClosed: boolean;
            tokensUsed: number;
            inputTokensUsed: number;
            cachedInputTokensUsed: number;
            outputTokensUsed: number;
            results: unknown[];
          }
        >;
      }
    ).sessions;

    sessions.set('src/api/service.ts', {
      file: 'src/api/service.ts',
      queue: [],
      isProcessing: false,
      isClosed: true,
      tokensUsed: 9,
      inputTokensUsed: 8,
      cachedInputTokensUsed: 0,
      outputTokensUsed: 1,
      results: [priorResult],
    });

    validator.enqueue({
      id: 'late-issue',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Late issue',
      description: 'This issue arrived after the previous session closed.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush(500);

    expect(result.issues.map((issue) => issue.id)).toEqual(['prior-issue', 'late-issue']);
    expect(result.issues[1]).toMatchObject({
      id: 'late-issue',
      validation_status: 'confirmed',
    });
    expect(result.inputTokensUsed).toBe(9);
    expect(result.outputTokensUsed).toBe(2);
  });

  it('starts a fresh session for an issue arriving while a failed session is closing', async () => {
    let signalCloseStarted: (() => void) | undefined;
    let releaseClose: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let executionCount = 0;

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
      execute: executeMock.mockImplementation(() => {
        executionCount++;
        const currentExecution = executionCount;
        return {
          async *[Symbol.asyncIterator]() {
            if (currentExecution === 1) {
              throw new Error('terminal validator crash');
            }

            const responseText = JSON.stringify({
              validation_status: 'confirmed',
              final_confidence: 0.9,
              grounding_evidence: {
                checked_files: ['src/api/service.ts'],
                checked_symbols: [],
                related_context: 'Issue validated after replacing the failed session.',
                reasoning: 'The fresh session accepted the issue.',
              },
            });
            yield { type: 'assistant.text', text: responseText };
            yield {
              type: 'result',
              status: 'success',
              usage: { inputTokens: 1, outputTokens: 1 },
              text: responseText,
            };
          },
          close: async () => {
            if (currentExecution === 1) {
              signalCloseStarted?.();
              await closeGate;
            }
          },
        };
      }),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      challengeMode: false,
      maxChallengeRounds: 1,
      language: 'en',
    });

    const sessions = (
      validator as unknown as {
        sessions: Map<
          string,
          {
            file: string;
            queue: unknown[];
            isProcessing: boolean;
            isClosed: boolean;
            tokensUsed: number;
            inputTokensUsed: number;
            cachedInputTokensUsed: number;
            outputTokensUsed: number;
            results: unknown[];
            crashRetryCount?: number;
          }
        >;
      }
    ).sessions;

    sessions.set('src/api/service.ts', {
      file: 'src/api/service.ts',
      queue: [],
      isProcessing: false,
      isClosed: false,
      tokensUsed: 0,
      inputTokensUsed: 0,
      cachedInputTokensUsed: 0,
      outputTokensUsed: 0,
      results: [],
      crashRetryCount: 2,
    });

    validator.enqueue({
      id: 'terminal-crash',
      file: 'src/api/service.ts',
      line_start: 10,
      line_end: 10,
      category: 'logic',
      severity: 'warning',
      title: 'Terminal crash',
      description: 'The session exhausts its recovery budget.',
      confidence: 0.8,
      source_agent: 'logic-reviewer',
    });

    await closeStarted;

    validator.enqueue({
      id: 'arrived-during-close',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Arrived during cleanup',
      description: 'This issue arrives while the previous execution is closing.',
      confidence: 0.88,
      source_agent: 'logic-reviewer',
    });

    releaseClose?.();
    const result = await validator.flush(500);

    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(result.issues.map((issue) => issue.id)).toEqual([
      'terminal-crash',
      'arrived-during-close',
    ]);
    expect(result.issues[1]).toMatchObject({
      id: 'arrived-during-close',
      validation_status: 'confirmed',
    });
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

  it('aggregates cached validator tokens and forwards the validator reasoning effort', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: {
          main: 'gpt-5.3-codex',
          light: 'gpt-5-mini',
          validator: 'gpt-5.3-codex',
        },
        reasoningEffort: 'high',
        validatorReasoningEffort: 'medium',
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
            final_confidence: 0.9,
            grounding_evidence: {
              checked_files: ['src/api/service.ts'],
              checked_symbols: [],
              related_context: 'The guard branch is observed in the changed code.',
              reasoning: 'The optional payload is now checked before use.',
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
              inputTokens: 1200,
              cachedInputTokens: 900,
              outputTokens: 80,
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

    validator.enqueue({
      id: 'issue-cached',
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

    const result = await validator.flush();

    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.3-codex',
        reasoningEffort: 'medium',
      })
    );
    expect(result.inputTokensUsed).toBe(1200);
    expect(result.cachedInputTokensUsed).toBe(900);
    expect(result.outputTokensUsed).toBe(80);
  });

  it('skips the fast-mode confirmation round when round 1 is conclusive', async () => {
    const responseText = JSON.stringify({
      validation_status: 'rejected',
      final_confidence: 0.2,
      grounding_evidence: {
        checked_files: ['src/api/service.ts'],
        checked_symbols: [],
        related_context: 'The guard branch is observed in the changed code.',
        reasoning: 'The optional payload is checked before use.',
      },
    });
    let promptCount = 0;

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
          promptCount++;

          yield {
            type: 'assistant.text',
            text: responseText,
          };

          yield {
            type: 'result',
            status: 'success',
            usage: {
              inputTokens: 20,
              outputTokens: 5,
            },
            text: responseText,
          };

          const nextPrompt = await iterator.next();
          if (!nextPrompt.done) {
            promptCount++;
            yield {
              type: 'assistant.text',
              text: responseText,
            };
            yield {
              type: 'result',
              status: 'success',
              usage: {
                inputTokens: 30,
                outputTokens: 5,
              },
              text: responseText,
            };
          }
        },
        close: closeMock,
      })),
    });

    const validator = createStreamingValidator({
      repoPath: 'C:\\repo',
      fastMode: true,
      challengeMode: true,
      maxChallengeRounds: 2,
      language: 'en',
    });

    validator.enqueue({
      id: 'issue-fast-rejected',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic',
      severity: 'warning',
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      suggestion: 'Guard the null path before accessing response fields.',
      confidence: 0.9,
      source_agent: 'logic-reviewer',
    });

    const result = await validator.flush();

    expect(promptCount).toBe(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.issues[0]).toMatchObject({
      id: 'issue-fast-rejected',
      validation_status: 'rejected',
      final_confidence: 0.2,
    });
  });

  it('caps per-issue validator tool calls and pushes the model to a verdict', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'argus-validator-budget-'));
    tempDirs.push(repoPath);
    await writeFile(
      join(repoPath, 'service.ts'),
      Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n')
    );

    const previousBudget = process.env.ARGUS_VALIDATOR_TOOL_BUDGET;
    process.env.ARGUS_VALIDATOR_TOOL_BUDGET = '2';
    try {
      let firstPromptText = '';
      let firstNote = '';
      let secondNote = '';
      let blockedText = '';

      createRuntimeFromEnvMock.mockReturnValue({
        kind: 'openai-responses',
        config: {
          runtime: 'openai-responses',
          models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
          openai: { apiKey: 'openai-key', source: 'argus' },
        },
        execute: executeMock.mockImplementation((options) => ({
          async *[Symbol.asyncIterator]() {
            const iterator = options.prompt[Symbol.asyncIterator]();
            const firstPrompt = await iterator.next();
            firstPromptText = firstPrompt.value.message.content;

            const readTool = options.tools.find((tool: { name: string }) => tool.name === 'Read');
            const first = await readTool.execute({ file_path: 'service.ts' });
            firstNote = first.content[first.content.length - 1].text;
            const second = await readTool.execute({ file_path: 'service.ts', offset: 20 });
            secondNote = second.content[second.content.length - 1].text;
            const third = await readTool.execute({ file_path: 'missing-file.ts' });
            blockedText = third.content[0].text;

            const responseText = JSON.stringify({
              validation_status: 'rejected',
              final_confidence: 0.8,
              grounding_evidence: {
                checked_files: ['service.ts'],
                checked_symbols: [],
                related_context: 'Service file read.',
                reasoning: 'The cited defect is not present in the changed range.',
              },
            });

            yield { type: 'assistant.text', text: responseText };
            yield {
              type: 'result',
              status: 'success',
              usage: { inputTokens: 1, outputTokens: 1 },
              text: responseText,
            };
          },
          close: closeMock,
        })),
      });

      const validator = createStreamingValidator({
        repoPath,
        maxChallengeRounds: 1,
        language: 'en',
      });

      validator.enqueue({
        id: 'issue-tool-budget',
        file: 'service.ts',
        line_start: 18,
        line_end: 21,
        category: 'logic',
        severity: 'warning',
        title: 'Missing null guard',
        description: 'The API helper dereferences a nullable response.',
        code_snippet: 'var value = response.Value;',
        confidence: 0.88,
        source_agent: 'logic-reviewer',
      });

      const result = await validator.flush();

      expect(firstPromptText).toContain('先核对上方代码片段');
      expect(firstNote).toContain('[Validator budget] 1/2 tool calls used');
      expect(secondNote).toContain('0 left');
      expect(blockedText).toContain('budget for this issue is exhausted');
      expect(blockedText).not.toContain('ENOENT');
      expect(result.issues[0]).toMatchObject({
        id: 'issue-tool-budget',
        validation_status: 'rejected',
      });
      expect(result.incompleteReasons).toEqual([]);
    } finally {
      if (previousBudget === undefined) {
        delete process.env.ARGUS_VALIDATOR_TOOL_BUDGET;
      } else {
        process.env.ARGUS_VALIDATOR_TOOL_BUDGET = previousBudget;
      }
    }
  });

  it('only claims the attached snippet covers the range when it was not truncated', async () => {
    const prompts: string[] = [];
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: { main: 'gpt-5.3-codex', light: 'gpt-5-mini', validator: 'gpt-5.3-codex' },
        openai: { apiKey: 'openai-key', source: 'argus' },
      },
      execute: executeMock.mockImplementation((options) => ({
        async *[Symbol.asyncIterator]() {
          const iterator = options.prompt[Symbol.asyncIterator]();
          const firstPrompt = await iterator.next();
          prompts.push(firstPrompt.value.message.content);

          const responseText = JSON.stringify({
            validation_status: 'rejected',
            final_confidence: 0.8,
            grounding_evidence: {
              checked_files: [],
              checked_symbols: [],
              related_context: 'ok',
              reasoning: 'ok',
            },
          });
          yield { type: 'assistant.text', text: responseText };
          yield {
            type: 'result',
            status: 'success',
            usage: { inputTokens: 1, outputTokens: 1 },
            text: responseText,
          };
        },
        close: closeMock,
      })),
    });

    const baseIssue = {
      id: 'issue-snippet',
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      category: 'logic' as const,
      severity: 'warning' as const,
      title: 'Missing null guard',
      description: 'The API helper dereferences a nullable response.',
      confidence: 0.88,
      source_agent: 'logic-reviewer' as const,
    };

    const shortSnippet = createStreamingValidator({
      repoPath: 'C:\\repo',
      maxChallengeRounds: 1,
      language: 'en',
    });
    shortSnippet.enqueue({ ...baseIssue, code_snippet: 'var value = response.Value;' });
    await shortSnippet.flush();

    const longSnippet = createStreamingValidator({
      repoPath: 'C:\\repo',
      maxChallengeRounds: 1,
      language: 'en',
    });
    longSnippet.enqueue({ ...baseIssue, id: 'issue-snippet-long', code_snippet: 'x'.repeat(6001) });
    await longSnippet.flush();

    expect(prompts[0]).toContain('它已覆盖报告位置的改动');
    expect(prompts[0]).not.toContain('片段已截断');
    expect(prompts[1]).toContain('片段已截断');
  });
});
