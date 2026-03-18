import { describe, expect, it } from 'vitest';
import {
  buildStreamingSystemPrompt,
  buildStreamingUserPrompt,
  getReportIssueToolInstructions,
} from '../../src/review/prompts/streaming.js';

const prContext = {
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

describe('streaming prompts', () => {
  it('adds stronger report-early guidance without binding to one exact sentence', () => {
    const toolInstructions = getReportIssueToolInstructions('zh');
    const systemPrompt = buildStreamingSystemPrompt('performance-reviewer', 'zh');

    expect(toolInstructions).toMatch(/report/i);
    expect(toolInstructions).toMatch(/immediately/i);
    expect(toolInstructions).toMatch(/one by one/i);
    expect(systemPrompt).toMatch(/report issues immediately/i);
    expect(systemPrompt).toMatch(/do not output json/i);
  });

  it('compresses style reviewer context deterministically', () => {
    const stylePrompt = buildStreamingUserPrompt('style-reviewer', {
      diff: '+ const x = 1',
      fileAnalyses:
        '- a.ts: summary\n- b.ts: summary\n- c.ts: summary\n- d.ts: summary\n- e.ts: summary\n- f.ts: summary',
      standardsText: 'STANDARD',
      projectRules: Array.from({ length: 12 }, (_, i) => `rule ${i + 1}`).join('\n'),
      deletedFilesContext: 'deleted file context',
      prContext,
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
      prContext,
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
      prContext,
    });

    const securityPrompt = buildStreamingUserPrompt('security-reviewer', {
      diff: '+ const x = 1',
      fileAnalyses: Array.from(
        { length: 12 },
        (_, i) => `- file-${i + 1}.ts: summary ${i + 1}`
      ).join('\n'),
      standardsText: 'STANDARD',
      projectRules: Array.from({ length: 12 }, (_, i) => `rule ${i + 1}`).join('\n'),
      prContext,
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
