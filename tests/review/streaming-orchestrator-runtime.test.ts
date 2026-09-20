import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createRuntimeFromEnvMock,
  executeMock,
  closeMock,
  queryMock,
  createSdkMcpServerMock,
  toolMock,
} = vi.hoisted(() => ({
  createRuntimeFromEnvMock: vi.fn(),
  executeMock: vi.fn(),
  closeMock: vi.fn(async () => undefined),
  queryMock: vi.fn(() => {
    throw new Error('query should not be used when runtime abstraction is active');
  }),
  createSdkMcpServerMock: vi.fn((server: unknown) => server),
  toolMock: vi.fn((name, description, inputSchema, handler) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));

vi.mock('../../src/runtime/factory.js', () => ({
  createRuntimeFromEnv: createRuntimeFromEnvMock,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
  createSdkMcpServer: createSdkMcpServerMock,
  tool: toolMock,
}));

import { StreamingReviewOrchestrator } from '../../src/review/streaming-orchestrator.js';

describe('streaming orchestrator runtime bridge', () => {
  beforeEach(() => {
    createRuntimeFromEnvMock.mockReset();
    executeMock.mockReset();
    closeMock.mockClear();
    queryMock.mockClear();
    createSdkMcpServerMock.mockClear();
    toolMock.mockClear();
  });

  it('executes built-in review agents through the runtime tool bridge', async () => {
    let capturedPrompt = '';

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
          capturedPrompt = String(options.prompt);
          await options.tools?.[0]?.execute({
            file: 'src/api/service.ts',
            line_start: 18,
            line_end: 21,
            severity: 'warning',
            category: 'logic',
            title: 'Missing error handling',
            description: 'The new API path swallows failures.',
            suggestion: 'Handle and surface network failures.',
            confidence: 0.9,
          });

          yield {
            type: 'result',
            status: 'success',
            usage: {
              inputTokens: 11,
              cachedInputTokens: 5,
              outputTokens: 7,
            },
            text: 'Done',
          };
        },
        close: closeMock,
      })),
    });

    const orchestrator = new StreamingReviewOrchestrator({
      skipValidation: true,
      progressMode: 'silent',
    });

    const result = await (orchestrator as any).runAgentsWithStreaming(
      {
        repoPath: 'C:\\repo',
        diff: {
          diff: '+fetch("/api/service")',
        },
        fileAnalyses: [
          {
            file_path: 'src/api/service.ts',
            semantic_hints: {
              summary: 'API service changes',
            },
          },
        ],
        standards: {
          source: [],
        },
        diffFiles: [],
        dependencyContext: {
          snapshots: [
            {
              packageRoot: '.',
              packageManager: 'npm',
              appliesToFiles: ['src/api/service.ts'],
              dependencies: [
                {
                  name: 'react-router-dom',
                  declaredVersion: '^7.10.1',
                  resolvedVersion: '7.10.1',
                },
              ],
            },
          ],
        },
      },
      'C:\\repo',
      ['logic-reviewer']
    );

    expect(createRuntimeFromEnvMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'C:\\repo',
        model: 'gpt-5.3-codex',
        toolNamespace: 'code-review-tools',
        tools: expect.any(Array),
      })
    );
    expect(
      executeMock.mock.calls[0]?.[0]?.tools?.map((tool: { name: string }) => tool.name)
    ).toEqual(['report_issue', 'Read', 'Grep', 'Glob']);
    expect(queryMock).not.toHaveBeenCalled();
    expect(result.tokens).toBe(18);
    expect(result.cachedInputTokensUsed).toBe(5);
    expect((orchestrator as any).rawIssuesForSkipMode).toHaveLength(1);
    expect((orchestrator as any).rawIssuesForSkipMode[0]).toMatchObject({
      file: 'src/api/service.ts',
      title: 'Missing error handling',
      source_agent: 'logic-reviewer',
    });
    expect(capturedPrompt).toContain('Frontend Dependency Versions');
    expect(capturedPrompt).toContain('react-router-dom');
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

const minimalReviewContext = {
  repoPath: 'C:\\repo',
  diff: {
    diff: '+const ready = true',
  },
  fileAnalyses: [],
  standards: {
    source: [],
  },
  diffFiles: [],
};

function createMaxTurnsRuntime(options: { callReportIssue?: boolean } = {}) {
  return {
    kind: 'openai-responses',
    config: {
      runtime: 'openai-responses',
      models: { main: 'gpt-5.3-codex' },
    },
    execute: (execOptions: {
      tools?: Array<{ execute: (args: Record<string, unknown>) => Promise<unknown> }>;
    }) => ({
      async *[Symbol.asyncIterator]() {
        if (options.callReportIssue) {
          await execOptions.tools?.[0]?.execute({
            file: 'src/api/service.ts',
            line_start: 18,
            line_end: 21,
            severity: 'warning',
            category: 'logic',
            title: 'Missing error handling',
            description: 'The new API path swallows failures.',
            suggestion: 'Handle and surface network failures.',
            confidence: 0.9,
          });
        }

        yield {
          type: 'result',
          status: 'error_max_turns',
          usage: {
            inputTokens: 11,
            cachedInputTokens: 5,
            outputTokens: 7,
          },
          text: 'Partial summary',
          error: 'max turns reached',
        };
      },
      close: async () => undefined,
    }),
  };
}

describe('streaming orchestrator max-turn handling', () => {
  beforeEach(() => {
    createRuntimeFromEnvMock.mockReset();
    executeMock.mockReset();
    closeMock.mockClear();
  });

  it('fails a max-turn run that reported zero issues so it can be retried', async () => {
    const orchestrator = new StreamingReviewOrchestrator({
      skipValidation: true,
      progressMode: 'silent',
    });

    await expect(
      (orchestrator as any).runStreamingAgent(
        'security-reviewer',
        minimalReviewContext,
        '',
        createMaxTurnsRuntime(),
        () => [],
        'C:\\repo',
        15,
        'security-invocation-1'
      )
    ).rejects.toThrow(/reached maxTurns with 0 reported issues/);
  });

  it('keeps already reported issues as a partial success on max-turn exhaustion', async () => {
    const orchestrator = new StreamingReviewOrchestrator({
      skipValidation: true,
      progressMode: 'silent',
    });
    const toolsFactory = (agentType: string, invocationKey: string) =>
      (orchestrator as any).createReportIssueRuntimeTools()(agentType, invocationKey);

    const result = await (orchestrator as any).runStreamingAgent(
      'logic-reviewer',
      minimalReviewContext,
      '',
      createMaxTurnsRuntime({ callReportIssue: true }),
      toolsFactory,
      'C:\\repo',
      24,
      'logic-invocation-1'
    );

    expect(result.tokensUsed).toBe(18);
    expect((orchestrator as any).rawIssuesForSkipMode).toHaveLength(1);
    expect((orchestrator as any).getInvocationIssueCount('logic-invocation-1')).toBe(1);
  });

  it('treats a deduplicated report as output instead of a zero-issue run', async () => {
    const orchestrator = new StreamingReviewOrchestrator({
      skipValidation: true,
      progressMode: 'silent',
    });
    (orchestrator as any).realtimeDeduplicator = {
      checkAndAdd: async () => ({
        isDuplicate: true,
        duplicateOf: { title: 'Existing issue' },
        reason: 'same root cause',
      }),
    };
    const toolsFactory = (agentType: string, invocationKey: string) =>
      (orchestrator as any).createReportIssueRuntimeTools()(agentType, invocationKey);

    const result = await (orchestrator as any).runStreamingAgent(
      'logic-reviewer',
      minimalReviewContext,
      '',
      createMaxTurnsRuntime({ callReportIssue: true }),
      toolsFactory,
      'C:\\repo',
      24,
      'dedup-invocation-1'
    );

    expect(result.tokensUsed).toBe(18);
    expect((orchestrator as any).getInvocationIssueCount('dedup-invocation-1')).toBe(1);
    expect((orchestrator as any).rawIssuesForSkipMode).toHaveLength(0);
  });

  it('retries a zero-issue max-turn agent with a larger budget and emits an agent error', async () => {
    const events: Array<{ type: string; data?: Record<string, unknown> }> = [];

    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'openai-responses',
      config: {
        runtime: 'openai-responses',
        models: { main: 'gpt-5.3-codex' },
      },
      execute: executeMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            status: 'error_max_turns',
            usage: {
              inputTokens: 5,
              cachedInputTokens: 0,
              outputTokens: 1,
            },
            text: '',
            error: 'max turns reached',
          };
        },
        close: closeMock,
      })),
    });

    const orchestrator = new StreamingReviewOrchestrator({
      skipValidation: true,
      progressMode: 'auto',
      onEvent: (event: any) => events.push(event),
    });

    await expect(
      (orchestrator as any).runAgentsWithStreaming(minimalReviewContext, 'C:\\repo', [
        'security-reviewer',
      ])
    ).rejects.toThrow(/Review failed: 1 agent\(s\) failed after 2 retries/);

    const maxTurnsPerAttempt = executeMock.mock.calls.map(
      (call) => (call[0] as { maxTurns?: number }).maxTurns
    );
    expect(maxTurnsPerAttempt).toEqual([29, 37]);
    expect(
      events.find(
        (event) =>
          event.type === 'agent:complete' &&
          event.data?.agent === 'security-reviewer' &&
          event.data?.status === 'error'
      )
    ).toBeDefined();
  });
});
