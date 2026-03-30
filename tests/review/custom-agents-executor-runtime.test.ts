import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createRuntimeFromEnvMock, closeMock, executeMock } = vi.hoisted(() => ({
  createRuntimeFromEnvMock: vi.fn(),
  closeMock: vi.fn(async () => undefined),
  executeMock: vi.fn(),
}));

vi.mock('../../src/runtime/factory.js', () => ({
  createRuntimeFromEnv: createRuntimeFromEnvMock,
}));

import { executeCustomAgent } from '../../src/review/custom-agents/executor.js';
import type { LoadedCustomAgent } from '../../src/review/custom-agents/types.js';

function createAgent(): LoadedCustomAgent {
  return {
    id: 'custom:test-agent',
    source_file: '.argus/agents/test-agent.yaml',
    name: 'test-agent',
    description: 'Review API changes',
    prompt: 'Inspect the diff and report issues.',
    enabled: true,
  };
}

describe('custom agent executor runtime bridge', () => {
  beforeEach(() => {
    closeMock.mockClear();
    executeMock.mockReset();
    createRuntimeFromEnvMock.mockReset();
  });

  it('executes custom agents through the runtime tool bridge', async () => {
    createRuntimeFromEnvMock.mockReturnValue({
      kind: 'claude-agent',
      config: {
        runtime: 'claude-agent',
        models: {
          main: 'claude-main',
          light: 'claude-light',
          validator: 'claude-validator',
        },
        claude: {
          apiKey: 'claude-key',
          source: 'argus',
        },
      },
      execute: executeMock.mockImplementation((options) => ({
        async *[Symbol.asyncIterator]() {
          await options.tools?.[0]?.execute({
            file: 'src/api/service.ts',
            line_start: 18,
            line_end: 21,
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

    const result = await executeCustomAgent(createAgent(), {
      repoPath: 'C:\\repo',
      diffContent: '+fetch("/api/service")',
      language: 'en',
    });

    expect(createRuntimeFromEnvMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: 'C:\\repo',
        maxTurns: 20,
        toolNamespace: 'custom-agent-tools',
        tools: expect.any(Array),
      })
    );

    const runtimeOptions = executeMock.mock.calls[0]?.[0];
    expect(runtimeOptions.prompt).toContain('Inspect the diff and report issues.');
    expect(runtimeOptions.prompt).toContain('fetch("/api/service")');

    expect(result.agent_id).toBe('custom:test-agent');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      file: 'src/api/service.ts',
      line_start: 18,
      line_end: 21,
      title: 'Missing error handling',
      description: 'The new API path swallows failures.',
      suggestion: 'Handle and surface network failures.',
      source_agent: 'custom:test-agent',
    });
    expect(result.input_tokens_used).toBe(11);
    expect(result.output_tokens_used).toBe(7);
    expect(result.tokens_used).toBe(18);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
