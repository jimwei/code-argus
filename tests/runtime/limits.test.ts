import { describe, expect, it } from 'vitest';

import { getSegmentSizeLimitForRuntime } from '../../src/runtime/limits.js';

describe('runtime limits', () => {
  it('uses a larger segment size for openai-responses', () => {
    expect(getSegmentSizeLimitForRuntime('openai-responses')).toBe(256 * 1024);
  });

  it('keeps the default segment size for claude-agent', () => {
    expect(getSegmentSizeLimitForRuntime('claude-agent')).toBe(150 * 1024);
  });
});
