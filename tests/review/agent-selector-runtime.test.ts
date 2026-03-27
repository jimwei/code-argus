import { beforeEach, describe, expect, it, vi } from 'vitest';

const { anthropicCreateMock, generateTextMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(() => {
    throw new Error('Anthropic client should not be used when runtime handles selector calls');
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

import { selectAgents } from '../../src/review/agent-selector.js';
import type { DiffFile } from '../../src/git/parser.js';

function createDiffFile(path: string): DiffFile {
  return {
    path,
    category: 'data',
    type: 'modify',
    content: `diff content for ${path}`,
  };
}

describe('agent selector runtime bridge', () => {
  beforeEach(() => {
    anthropicCreateMock.mockClear();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        agents: ['style-reviewer'],
        reasons: {
          'style-reviewer': 'docs changes still need style review',
        },
      }),
      usage: {
        inputTokens: 4,
        outputTokens: 2,
      },
    });
  });

  it('routes LLM selection through the active runtime', async () => {
    const result = await selectAgents([createDiffFile('README.md')]);

    expect(result.usedLLM).toBe(true);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'runtime-light-model',
        prompt: expect.stringContaining('README.md'),
      })
    );
    expect(anthropicCreateMock).not.toHaveBeenCalled();
  });
});
