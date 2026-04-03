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

  it('injects frontend dependency grounding and warns against newer-version API suggestions', () => {
    const prompt = buildStreamingUserPrompt('logic-reviewer', {
      diff: '+import { createBrowserRouter } from "react-router-dom"',
      dependencyContextText: `## Frontend Dependency Versions

- Package root: packages/web
- react-router-dom: declared ^7.10.1, resolved 7.10.1

React 19+ compatibility notes:
- Treat ref as a regular prop on function components; do not require forwardRef solely to receive or pass refs.`,
    } as any);

    expect(prompt).toContain('## Frontend Dependency Versions');
    expect(prompt).toContain('react-router-dom');
    expect(prompt).toContain('Do not suggest APIs introduced after these versions');
    expect(prompt).toContain('state that an upgrade is required');
    expect(prompt).toContain('ref as a regular prop');
    expect(prompt).toContain('forwardRef solely to receive or pass refs');
    expect(prompt).toContain('compatibility notes');
  });
});
