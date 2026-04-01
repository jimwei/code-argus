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
    expect(queryMock).not.toHaveBeenCalled();
    expect(result.tokens).toBe(18);
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
