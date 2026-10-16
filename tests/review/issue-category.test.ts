import { describe, expect, it } from 'vitest';

import {
  ISSUE_CATEGORIES,
  isIssueCategory,
  isRecognizedIssueCategory,
  normalizeIssueCategory,
} from '../../src/review/types.js';

describe('issue category guards', () => {
  it('accepts only canonical categories in the strict guard', () => {
    for (const category of ISSUE_CATEGORIES) {
      expect(isIssueCategory(category)).toBe(true);
    }

    expect(isIssueCategory('documentation')).toBe(false);
    expect(isIssueCategory('Logic')).toBe(false);
    expect(isIssueCategory('toString')).toBe(false);
    expect(isIssueCategory(undefined)).toBe(false);
  });

  it('recognizes aliases and case variants', () => {
    expect(isRecognizedIssueCategory(' documentation ')).toBe(true);
    expect(isRecognizedIssueCategory('Correctness')).toBe(true);
    expect(isRecognizedIssueCategory('SECURITY')).toBe(true);
    expect(isRecognizedIssueCategory('correct-ness')).toBe(false);
    expect(isRecognizedIssueCategory('toString')).toBe(false);
    expect(isRecognizedIssueCategory('')).toBe(false);
  });

  it('normalizes unknown values into the fallback bucket', () => {
    expect(normalizeIssueCategory(' Security ')).toBe('security');
    expect(normalizeIssueCategory('correctness')).toBe('logic');
    expect(normalizeIssueCategory(' documentation ')).toBe('maintainability');
    expect(normalizeIssueCategory('something else')).toBe('maintainability');
    expect(normalizeIssueCategory('toString')).toBe('maintainability');
    expect(normalizeIssueCategory(undefined)).toBe('maintainability');
    expect(normalizeIssueCategory(null, 'logic')).toBe('logic');
  });
});
