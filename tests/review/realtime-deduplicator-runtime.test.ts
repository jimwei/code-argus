import { beforeEach, describe, expect, it, vi } from 'vitest';

const { anthropicCreateMock, generateTextMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(() => {
    throw new Error('Anthropic client should not be used when runtime handles deduplication');
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
  getApiKey: () => 'test-api-key',
  getBaseUrl: () => undefined,
  getRuntimeModel: () => 'runtime-light-model',
}));

import { RealtimeDeduplicator } from '../../src/review/realtime-deduplicator.js';
import type { AgentType, RawIssue } from '../../src/review/types.js';

function createTestIssue(overrides: Partial<RawIssue> = {}): RawIssue {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    file: 'src/test.ts',
    line_start: 10,
    line_end: 15,
    category: 'logic',
    severity: 'warning',
    title: 'Test issue',
    description: 'Test description',
    confidence: 0.8,
    source_agent: 'logic-reviewer' as AgentType,
    ...overrides,
  };
}

describe('realtime deduplicator runtime bridge', () => {
  beforeEach(() => {
    anthropicCreateMock.mockClear();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        is_duplicate: false,
        duplicate_of_id: null,
        reason: 'Different issues',
      }),
      usage: {
        inputTokens: 6,
        outputTokens: 3,
      },
    });
  });

  it('routes semantic duplicate checks through the active runtime', async () => {
    const deduplicator = new RealtimeDeduplicator({ verbose: false });

    await deduplicator.checkAndAdd(
      createTestIssue({
        id: 'issue-1',
        file: 'src/test.ts',
        line_start: 10,
        line_end: 15,
      })
    );

    await deduplicator.checkAndAdd(
      createTestIssue({
        id: 'issue-2',
        file: 'src/test.ts',
        line_start: 12,
        line_end: 18,
      })
    );

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'runtime-light-model',
        prompt: expect.stringContaining('NEW ISSUE'),
      })
    );
    expect(anthropicCreateMock).not.toHaveBeenCalled();
    expect(deduplicator.getStats()).toMatchObject({
      inputTokensUsed: 6,
      outputTokensUsed: 3,
      tokensUsed: 9,
    });
  });
});
