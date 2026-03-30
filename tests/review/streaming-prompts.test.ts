import { describe, expect, it } from 'vitest';
import { buildStreamingUserPrompt } from '../../src/review/prompts/streaming.js';

describe('streaming specialist prompts', () => {
  it('tells style reviewers to avoid low-value naming and spelling nits', () => {
    const prompt = buildStreamingUserPrompt('style-reviewer', {
      diff: '+const recieveValue = getValue()',
    });

    expect(prompt).toContain('Do NOT report');
    expect(prompt).toContain('minor spelling');
    expect(prompt).toContain('naming preferences');
  });

  it('tells performance reviewers to skip speculative best-practice suggestions', () => {
    const prompt = buildStreamingUserPrompt('performance-reviewer', {
      diff: '+items.map(item => renderItem(item))',
    });

    expect(prompt).toContain('best-practice');
    expect(prompt).toContain('Do NOT report');
    expect(prompt).toContain('speculative');
  });
});
