import { beforeEach, describe, expect, it, vi } from 'vitest';

const { anthropicCreateMock, generateTextMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(() => {
    throw new Error('Anthropic client should not be used when runtime handles matcher calls');
  }),
  generateTextMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: anthropicCreateMock,
    };
  },
}));

vi.mock('../../src/runtime/factory.js', () => ({
  createRuntimeFromEnv: () => ({
    kind: 'openai-responses',
    generateText: generateTextMock,
  }),
}));

vi.mock('../../src/config/env.js', () => ({
  getRuntimeModel: () => 'runtime-light-model',
}));

import { matchCustomAgents } from '../../src/review/custom-agents/matcher.js';
import type { DiffFile } from '../../src/git/parser.js';
import type { LoadedCustomAgent } from '../../src/review/custom-agents/types.js';

function createDiffFile(path: string): DiffFile {
  return {
    path,
    category: 'source',
    type: 'modify',
    content: '+const value = 1;',
  };
}

function createAgent(): LoadedCustomAgent {
  return {
    id: 'custom:test-agent',
    source_file: '.claude/agents/test-agent.yaml',
    name: 'test-agent',
    description: 'Test custom agent',
    trigger_mode: 'llm',
    trigger_prompt: 'Run for documentation-related changes',
    prompt: 'Review the code',
    enabled: true,
  };
}

describe('custom agent matcher runtime bridge', () => {
  beforeEach(() => {
    anthropicCreateMock.mockClear();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        should_trigger: true,
        confidence: 0.9,
        reason: 'Triggered by test runtime decision',
      }),
      usage: {
        inputTokens: 5,
        outputTokens: 2,
      },
    });
  });

  it('routes LLM trigger evaluation through the active runtime', async () => {
    const result = await matchCustomAgents([createAgent()], [createDiffFile('README.md')], [], {
      disableLLM: false,
    });

    expect(result.usedLLM).toBe(true);
    expect(result.triggeredAgents).toHaveLength(1);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'runtime-light-model',
        prompt: expect.stringContaining('test-agent'),
      })
    );
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });
});
