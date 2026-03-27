import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
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

describe('selectAgents LLM model selection', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        agents: ['style-reviewer'],
        reasons: {
          'style-reviewer': 'docs changes still need style review',
        },
      }),
    });
  });

  it('uses the runtime-configured light model when the LLM selector runs', async () => {
    const result = await selectAgents([createDiffFile('README.md')]);

    expect(result.usedLLM).toBe(true);
    expect(generateTextMock).toHaveBeenCalled();
    expect(generateTextMock.mock.calls[0]?.[0]?.model).toBe('runtime-light-model');
  });
});
