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

  it('executes fix verification through the runtime tool bridge', async () => {
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
        toolNamespace: 'fix-verifier-tools',
        tools: expect.any(Array),
      })
    );
    expect(queryMock).not.toHaveBeenCalled();

    const runtimeOptions = executeMock.mock.calls[0]?.[0];
    expect(runtimeOptions.prompt).toContain('Fix Verification Specialist');
    expect(runtimeOptions.prompt).toContain('issue-1');
    expect(runtimeOptions.prompt).toContain('fetch("/api/service")');

    expect(result.total_verified).toBe(2);
    expect(result.by_status.fixed).toBe(1);
    expect(result.by_status.missed).toBe(1);
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
});
