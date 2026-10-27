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
  createSdkMcpServer: vi.fn(),
  tool: vi.fn(),
}));

import { executeFixVerifier } from '../../src/review/fix-verifier.js';

describe('fix verifier runtime bridge', () => {
  beforeEach(() => {
    createRuntimeFromEnvMock.mockReset();
    executeMock.mockReset();
    closeMock.mockClear();
    queryMock.mockClear();
  });

  it.each(['medium', 'low', 'none', undefined])('validator effort %s', async (effort) => {
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
        validatorReasoningEffort: effort,
        openai: {
          apiKey: 'openai-key',
          source: 'argus',
        },
      },
      execute: executeMock.mockImplementation((options) => ({
        async *[Symbol.asyncIterator]() {
          await options.tools?.[0]?.execute({
            issue_id: 'issue-1',
            screening_status: 'resolved',
            quick_reasoning: 'The new guard covers the original null path.',
          });

          await options.tools?.[1]?.execute({
            issue_id: 'issue-2',
            status: 'missed',
            confidence: 0.91,
            evidence: {
              checked_files: ['src/api/service.ts'],
              examined_code: ['if (!response.ok) return;'],
              related_changes: 'The diff still returns early without surfacing the failure.',
              reasoning: 'The error path is still swallowed after the refactor.',
            },
            updated_issue: {
              title: 'HTTP failures are still ignored',
              description: 'The refactor still drops non-OK responses without notifying callers.',
              suggestion: 'Propagate or log the failure so callers can react.',
            },
            notes: 'Deep verification confirmed the original issue remains.',
          });

          yield {
            type: 'result',
            status: 'success',
            usage: {
              inputTokens: 13,
              outputTokens: 8,
            },
            text: 'Done',
          };
        },
        close: closeMock,
      })),
    });

    const result = await executeFixVerifier({
      repoPath: 'C:\\repo',
      diffContent: '+fetch("/api/service")',
      fileChangesSummary: 'src/api/service.ts updated error handling.',
      previousReview: {
        issues: [
          {
            id: 'issue-1',
            file: 'src/api/service.ts',
            line_start: 18,
            line_end: 21,
            category: 'logic',
            severity: 'warning',
            title: 'Missing null guard',
            description: 'The previous code path dereferenced a nullable response.',
            confidence: 0.84,
            source_agent: 'logic-reviewer',
          },
          {
            id: 'issue-2',
            file: 'src/api/service.ts',
            line_start: 25,
            line_end: 29,
            category: 'logic',
            severity: 'warning',
            title: 'Missing error propagation',
            description: 'The API helper hides failed responses.',
            suggestion: 'Bubble failures to callers.',
            confidence: 0.88,
            source_agent: 'logic-reviewer',
          },
        ],
      },
      language: 'en',
    });

    expect(createRuntimeFromEnvMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'C:\\repo',
        model: 'gpt-5.3-codex',
        ...(effort ? { reasoningEffort: effort } : {}),
        toolNamespace: 'fix-verifier-tools',
        tools: expect.any(Array),
      })
    );
    expect(
      executeMock.mock.calls[0]?.[0]?.tools?.map((tool: { name: string }) => tool.name)
    ).toEqual(['report_screening_result', 'report_verification_result', 'Read', 'Grep', 'Glob']);
    expect(queryMock).not.toHaveBeenCalled();

    const runtimeOptions = executeMock.mock.calls[0]?.[0];
    if (!effort) expect(runtimeOptions).not.toHaveProperty('reasoningEffort');
    expect(runtimeOptions).not.toHaveProperty('completionBudget');
    expect(runtimeOptions.prompt).toContain('Fix Verification Specialist');
    expect(runtimeOptions.prompt).toContain('issue-1');
    expect(runtimeOptions.prompt).toContain('fetch("/api/service")');

    expect(result.incomplete).toBeUndefined();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(result.total_verified).toBe(2);
    expect(result.by_status.fixed).toBe(1);
    expect(result.by_status.missed).toBe(1);
    expect(result.input_tokens_used).toBe(13);
    expect(result.output_tokens_used).toBe(8);
    expect(result.tokens_used).toBe(21);
    expect(result.results).toHaveLength(2);

    const missedResult = result.results.find((entry) => entry.original_issue_id === 'issue-2');
    expect(missedResult).toBeDefined();
    expect(missedResult).toMatchObject({
      original_issue_id: 'issue-2',
      status: 'missed',
      confidence: 0.91,
      updated_issue: {
        title: 'HTTP failures are still ignored',
      },
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('reports runtime error results through the existing progress error path', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        models: { validator: 'gpt-5' },
        validatorReasoningEffort: 'medium',
      },
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            status: 'error',
            error: 'upstream disconnected',
            usage: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 },
          };
        },
        close: closeMock,
      })),
    });
    const progress = { info: vi.fn(), error: vi.fn(), success: vi.fn() };
    const summary = await executeFixVerifier({
      repoPath: 'C:\\repo',
      previousReview: { issues: [] },
      diffContent: '+fetch("/api/service")',
      fileChangesSummary: 'fixture',
      progress: progress as any,
    });

    expect(progress.error).toHaveBeenCalledWith(expect.stringContaining('upstream disconnected'));
    expect(summary.incomplete).toBe(true);
    expect(summary.incomplete_reasons?.join(' ')).toContain('upstream disconnected');
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(progress.success).not.toHaveBeenCalled();
    expect(summary.tokens_used).toBe(110);
    expect(summary.cached_input_tokens_used).toBe(20);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  const previousIssue = (id: string) => ({
    id,
    file: 'src/api/service.ts',
    line_start: 10,
    line_end: 12,
    category: 'logic' as const,
    severity: 'warning' as const,
    title: `Previous ${id}`,
    description: 'A nullable response is dereferenced.',
    confidence: 0.9,
    source_agent: 'logic-reviewer' as const,
  });
  const verificationArgs = (id: string) => ({
    issue_id: id,
    status: 'fixed',
    confidence: 0.94,
    evidence: {
      checked_files: ['src/api/service.ts'],
      examined_code: ['if (!response) return;'],
      related_changes: 'Null guard added.',
      reasoning: 'The guard prevents the original null dereference.',
    },
  });
  const runtimeFixture = () => ({
    kind: 'openai-responses',
    config: { models: { validator: 'gpt-5' } },
    execute: executeMock,
  });
  const optionsFixture = () => ({
    repoPath: 'C:\\repo',
    diffContent: '+if (!response) return;',
    fileChangesSummary: 'Guard added.',
    previousReview: { issues: [previousIssue('verified'), previousIssue('missing')] },
  });

  it.each(['error', 'incomplete', 'error_max_turns'])(
    'retains partial tool results and concrete %s exhaustion reasons without replaying the verifier',
    async (status) => {
      createRuntimeFromEnvMock.mockReturnValue(runtimeFixture());
      executeMock.mockImplementation((options) => ({
        async *[Symbol.asyncIterator]() {
          await options.tools[1].execute(verificationArgs('verified'));
          yield {
            type: 'result',
            status,
            rawStopReason: 'incomplete.max_output_tokens',
            error: 'provider request retries exhausted',
            usage: { inputTokens: 12, cachedInputTokens: 5, outputTokens: 3 },
          };
        },
        close: closeMock,
      }));
      const onVerificationComplete = vi.fn();
      const summary = await executeFixVerifier({
        ...optionsFixture(),
        callbacks: { onVerificationComplete },
      });
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(closeMock).toHaveBeenCalledTimes(1);
      expect(onVerificationComplete).toHaveBeenCalledTimes(1);
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]).toMatchObject({
        original_issue_id: 'verified',
        status: 'fixed',
        confidence: 0.94,
      });
      expect(summary.incomplete).toBe(true);
      expect(summary.incomplete_reasons?.join(' ')).toContain('incomplete.max_output_tokens');
      expect(summary.incomplete_reasons?.join(' ')).toContain('provider request retries exhausted');
      expect(summary.incomplete_reasons?.join(' ')).toContain('missing');
      expect(summary.tokens_used).toBe(15);
      expect(summary.cached_input_tokens_used).toBe(5);
    }
  );

  it('marks missing coverage incomplete even after a successful runtime result', async () => {
    createRuntimeFromEnvMock.mockReturnValue(runtimeFixture());
    executeMock.mockImplementation((options) => ({
      async *[Symbol.asyncIterator]() {
        await options.tools[0].execute({
          issue_id: 'verified',
          screening_status: 'resolved',
          quick_reasoning: 'The null guard is present.',
        });
        await options.tools[0].execute({
          issue_id: 'missing',
          screening_status: 'unresolved',
          quick_reasoning: 'Deep verification is required.',
        });
        yield { type: 'result', status: 'success', usage: { inputTokens: 3, outputTokens: 1 } };
      },
      close: closeMock,
    }));
    const onScreeningComplete = vi.fn();
    const summary = await executeFixVerifier({
      ...optionsFixture(),
      callbacks: { onScreeningComplete },
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(onScreeningComplete).toHaveBeenCalledTimes(2);
    expect(summary.total_verified).toBe(1);
    expect(summary.results[0]).toMatchObject({
      original_issue_id: 'verified',
      status: 'fixed',
      confidence: 0.8,
    });
    expect(summary.incomplete).toBe(true);
    expect(summary.incomplete_reasons?.join(' ')).toContain(
      'missing results for 1 issue(s): missing'
    );
  });

  it('preserves partial results when the runtime ends without a terminal result', async () => {
    createRuntimeFromEnvMock.mockReturnValue(runtimeFixture());
    executeMock.mockImplementation((options) => ({
      async *[Symbol.asyncIterator]() {
        await options.tools[1].execute(verificationArgs('verified'));
        yield { type: 'assistant.text', text: 'Work stopped before the remaining verification.' };
      },
      close: closeMock,
    }));
    const summary = await executeFixVerifier(optionsFixture());
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.incomplete).toBe(true);
    expect(summary.incomplete_reasons?.join(' ')).toContain('without a terminal result');
    expect(summary.incomplete_reasons?.join(' ')).toContain('missing');
  });

  it('aggregates known per-prompt usage before a later failure', async () => {
    createRuntimeFromEnvMock.mockReturnValue(runtimeFixture());
    executeMock.mockImplementation((options) => ({
      async *[Symbol.asyncIterator]() {
        await options.tools[1].execute(verificationArgs('verified'));
        yield {
          type: 'result',
          status: 'success',
          usage: { inputTokens: 4, cachedInputTokens: 2, outputTokens: 1 },
        };
        yield {
          type: 'result',
          status: 'incomplete',
          rawStopReason: 'provider exhausted',
          usage: { inputTokens: 6, cachedInputTokens: 3, outputTokens: 2 },
        };
      },
      close: closeMock,
    }));
    const summary = await executeFixVerifier(optionsFixture());
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(summary.input_tokens_used).toBe(10);
    expect(summary.cached_input_tokens_used).toBe(5);
    expect(summary.output_tokens_used).toBe(3);
    expect(summary.tokens_used).toBe(13);
    expect(summary.incomplete).toBe(true);
  });

  it('passes cancellation to runtime and retains partial results without replay', async () => {
    createRuntimeFromEnvMock.mockReturnValue(runtimeFixture());
    const abortController = new AbortController();
    executeMock.mockImplementation((options) => ({
      // eslint-disable-next-line require-yield -- cancelled stream retains its already reported tool result
      async *[Symbol.asyncIterator]() {
        expect(options.abortController).toBe(abortController);
        await options.tools[1].execute(verificationArgs('verified'));
        abortController.abort(new Error('review stopped'));
        throw Object.assign(new Error('verification cancelled'), { name: 'AbortError' });
      },
      close: closeMock,
    }));
    const summary = await executeFixVerifier({ ...optionsFixture(), abortController });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(summary.results).toHaveLength(1);
    expect(summary.incomplete).toBe(true);
    expect(summary.incomplete_reasons?.join(' ')).toContain('cancelled');
  });

  it('does not start a verifier execution when already cancelled', async () => {
    createRuntimeFromEnvMock.mockReturnValue(runtimeFixture());
    const abortController = new AbortController();
    abortController.abort(new Error('review stopped'));
    const summary = await executeFixVerifier({ ...optionsFixture(), abortController });
    expect(executeMock).not.toHaveBeenCalled();
    expect(summary.incomplete).toBe(true);
    expect(summary.incomplete_reasons?.join(' ')).toContain('review stopped');
  });
});
