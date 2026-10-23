import { describe, expect, it } from 'vitest';
import {
  getHighSignalValidationPolicy,
  shouldIncludeIssueInFinalReport,
} from '../../src/review/high-signal-policy.js';

describe('high-signal validation policy', () => {
  it('uses the same 0.8 gate for strict warnings before and after validation', () => {
    const policy = getHighSignalValidationPolicy(
      { category: 'maintainability', severity: 'warning' },
      5
    );

    expect(policy.shouldValidate).toBe(true);
    expect(policy.minConfidence).toBe(0.8);
    expect(policy.maxChallengeRounds).toBe(2);
    expect(
      shouldIncludeIssueInFinalReport({
        category: 'maintainability',
        severity: 'warning',
        final_confidence: 0.79,
      })
    ).toBe(false);
    expect(
      shouldIncludeIssueInFinalReport({
        category: 'maintainability',
        severity: 'warning',
        final_confidence: 0.8,
      })
    ).toBe(true);
  });

  it('does not apply the strict warning gate to logic findings', () => {
    const policy = getHighSignalValidationPolicy({ category: 'logic', severity: 'warning' }, 3);

    expect(policy.shouldValidate).toBe(true);
    expect(policy.minConfidence).toBe(0.5);
    expect(
      shouldIncludeIssueInFinalReport({
        category: 'logic',
        severity: 'warning',
        final_confidence: 0.5,
      })
    ).toBe(true);
  });

  it('keeps low-signal suggestions out of validation and the report', () => {
    const policy = getHighSignalValidationPolicy({ category: 'style', severity: 'suggestion' }, 3);

    expect(policy.shouldValidate).toBe(false);
    expect(policy.maxChallengeRounds).toBe(0);
    expect(
      shouldIncludeIssueInFinalReport({
        category: 'style',
        severity: 'suggestion',
        final_confidence: 0.99,
      })
    ).toBe(false);
  });
});
