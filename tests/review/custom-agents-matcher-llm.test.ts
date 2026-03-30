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

describe('custom agent matcher LLM model selection', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        should_trigger: true,
        confidence: 0.9,
        reason: 'Triggered by test LLM decision',
      }),
    });
  });

  it('uses the runtime-configured light model for LLM trigger evaluation', async () => {
    const result = await matchCustomAgents([createAgent()], [createDiffFile('README.md')], [], {
      disableLLM: false,
    });

    expect(result.usedLLM).toBe(true);
    expect(result.triggeredAgents).toHaveLength(1);
    expect(generateTextMock).toHaveBeenCalled();
    expect(generateTextMock.mock.calls[0]?.[0]?.model).toBe('runtime-light-model');
  });
});
