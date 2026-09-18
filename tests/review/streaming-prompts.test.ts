import { describe, expect, it } from 'vitest';
import {
  buildStreamingSystemPrompt,
  buildStreamingUserPrompt,
  getReportIssueToolInstructions,
} from '../../src/review/prompts/streaming.js';

describe('streaming specialist prompts', () => {
  it('includes PR description even when there are no linked issues', () => {
    const prompt = buildStreamingUserPrompt('logic-reviewer', {
      diff: '+const ready = true',
      prContext: {
        prTitle: 'Improve login validation',
        prDescription: 'Handle special characters and keep backward compatibility.',
        issues: [],
      },
    } as any);

    expect(prompt).toContain('## PR Business Context');
    expect(prompt).toContain(
      '**PR Description**: Handle special characters and keep backward compatibility.'
    );
    expect(prompt).not.toContain('### Related Issues');
  });

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

const reviewerPrContext = {
  prTitle: 'Improve reviewer reliability',
  prDescription: 'Tighten reviewer execution behavior',
  issues: [
    { key: 'PR-1', type: 'story', summary: 'One', keyPoints: ['a'], reviewContext: 'ctx-1' },
    { key: 'PR-2', type: 'story', summary: 'Two', keyPoints: ['b'], reviewContext: 'ctx-2' },
    { key: 'PR-3', type: 'story', summary: 'Three', keyPoints: ['c'], reviewContext: 'ctx-3' },
    { key: 'PR-4', type: 'story', summary: 'Four', keyPoints: ['d'], reviewContext: 'ctx-4' },
  ],
  parseStatus: 'found' as const,
};

describe('streaming max-turn reduction prompts', () => {
  it('adds stronger report-early guidance', () => {
    const toolInstructions = getReportIssueToolInstructions('zh');
    const systemPrompt = buildStreamingSystemPrompt('performance-reviewer', 'zh');

    expect(toolInstructions).toMatch(/report/i);
    expect(toolInstructions).toMatch(/immediately/i);
    expect(toolInstructions).toMatch(/one by one/i);
    expect(systemPrompt).toMatch(/report issues immediately/i);
    expect(systemPrompt).toMatch(/do not output json/i);
    expect(systemPrompt).toMatch(/partial but concrete findings/i);
  });

  it('compresses style reviewer context deterministically', () => {
    const stylePrompt = buildStreamingUserPrompt('style-reviewer', {
      diff: '+ const x = 1',
      fileAnalyses:
        '- a.ts: summary\n- b.ts: summary\n- c.ts: summary\n- d.ts: summary\n- e.ts: summary\n- f.ts: summary',
      standardsText: 'STANDARD',
      projectRules: Array.from({ length: 12 }, (_, i) => `rule ${i + 1}`).join('\n'),
      deletedFilesContext: 'deleted file context',
      prContext: reviewerPrContext,
    });

    expect(stylePrompt).not.toContain('## PR Business Context');
    expect(stylePrompt).not.toContain('deleted file context');
    expect(stylePrompt).not.toContain('#### PR-4');
    expect(stylePrompt).not.toContain('## File Change Analysis');
  });

  it('keeps full logic reviewer context', () => {
    const logicPrompt = buildStreamingUserPrompt('logic-reviewer', {
      diff: '+ const x = 1',
      fileAnalyses: '- a.ts: summary\n- b.ts: summary',
      standardsText: 'STANDARD',
      projectRules: Array.from({ length: 12 }, (_, i) => `rule ${i + 1}`).join('\n'),
      deletedFilesContext: 'deleted file context',
      prContext: reviewerPrContext,
    });

    expect(logicPrompt).toContain('## PR Business Context');
    expect(logicPrompt).toContain('deleted file context');
    expect(logicPrompt).toContain('#### PR-4');
    expect(logicPrompt).toContain('**关键点**:');
    expect(logicPrompt).toContain('- d');
  });

  it('applies summary/truncation rules for performance and security reviewers', () => {
    const performancePrompt = buildStreamingUserPrompt('performance-reviewer', {
      diff: '+ const x = 1',
      fileAnalyses: Array.from(
        { length: 12 },
        (_, i) => `- file-${i + 1}.ts: summary ${i + 1}`
      ).join('\n'),
      standardsText: 'STANDARD',
      projectRules: Array.from({ length: 12 }, (_, i) => `rule ${i + 1}`).join('\n'),
      prContext: reviewerPrContext,
    });

    const securityPrompt = buildStreamingUserPrompt('security-reviewer', {
      diff: '+ const x = 1',
      fileAnalyses: Array.from(
        { length: 12 },
        (_, i) => `- file-${i + 1}.ts: summary ${i + 1}`
      ).join('\n'),
      standardsText: 'STANDARD',
      projectRules: Array.from({ length: 12 }, (_, i) => `rule ${i + 1}`).join('\n'),
      prContext: reviewerPrContext,
    });

    expect(performancePrompt).toContain('## PR Business Context');
    expect(performancePrompt).not.toContain('#### PR-4');
    expect(performancePrompt).not.toContain('rule 11');
    expect(performancePrompt).not.toContain('file-11.ts');

    expect(securityPrompt).toContain('## PR Business Context');
    expect(securityPrompt).not.toContain('#### PR-4');
    expect(securityPrompt).toContain('rule 11');
  });
});
