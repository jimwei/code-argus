import { describe, expect, it } from 'vitest';
import {
  calculateMetrics,
  formatAsMarkdown,
  formatAsSummary,
  generateReport,
} from '../../src/review/report.js';
import type { ReviewMetadata, ValidatedIssue } from '../../src/review/types.js';

function metadata(complete?: boolean): ReviewMetadata {
  return {
    review_time_ms: 1,
    input_tokens_used: 0,
    cached_input_tokens_used: 0,
    output_tokens_used: 0,
    tokens_used: 0,
    agents_used: ['custom:primary'],
    review_complete: complete,
    incomplete_reasons:
      complete === false ? ['Turn budget exhausted', 'Missing dependency evidence'] : [],
  };
}

describe('incomplete report presentation', () => {
  it.each(['zh', 'en'] as const)(
    'labels incomplete empty reports and lists reasons in %s',
    (language) => {
      const report = generateReport(
        [],
        [],
        calculateMetrics([], []),
        undefined,
        metadata(false),
        language
      );
      const label = language === 'zh' ? '审核不完整' : 'Review incomplete';
      for (const [output, expectedLabel] of [
        [report.summary, label],
        [formatAsMarkdown(report, { language }), label],
        [formatAsSummary(report), 'Review incomplete'],
      ]) {
        expect(output).toContain(expectedLabel);
        expect(output).toContain('Turn budget exhausted');
        expect(output).toContain('Missing dependency evidence');
        expect(output).not.toMatch(/No (?:significant )?issues found|未发现(?:重大)?问题/i);
      }
    }
  );

  it('preserves partial findings and warns even without supplied reasons', () => {
    const issue: ValidatedIssue = {
      id: 'partial-1',
      file: 'src/service.ts',
      line_start: 3,
      line_end: 3,
      category: 'logic',
      severity: 'warning',
      title: 'Partial finding',
      description: 'Retain this finding',
      confidence: 0.9,
      source_agent: 'custom:primary',
      validation_status: 'confirmed',
      final_confidence: 0.9,
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: '',
        reasoning: '',
      },
    };
    const meta = metadata(false);
    meta.incomplete_reasons = [];
    const report = generateReport([issue], [], calculateMetrics([issue], [issue]), undefined, meta);
    expect(report.issues).toEqual([issue]);
    expect(report.summary).toContain('审核不完整');
    expect(formatAsMarkdown(report)).toContain('Partial finding');
    expect(formatAsSummary(report)).toContain('Review incomplete');
  });

  it.each([true, undefined])('keeps existing clean summary when complete=%s', (complete) => {
    const report = generateReport(
      [],
      [],
      calculateMetrics([], []),
      undefined,
      metadata(complete),
      'en'
    );
    expect(report.summary).toContain('No significant issues found');
    expect(formatAsMarkdown(report, { language: 'en' })).toContain('No issues found.');
    expect(formatAsSummary(report)).not.toContain('Review incomplete');
  });
});
