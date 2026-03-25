import { describe, expect, it } from 'vitest';
import { MAX_REVIEW_DIFF_SIZE_BYTES, shouldSkipReviewForDiffSize } from '../../src/review/constants.js';

describe('review diff size limit', () => {
  it('defaults to a 5MB review diff limit', () => {
    expect(MAX_REVIEW_DIFF_SIZE_BYTES).toBe(5 * 1024 * 1024);
  });

  it('does not skip review when diff size is within the 5MB limit', () => {
    expect(shouldSkipReviewForDiffSize(4 * 1024 * 1024)).toBe(false);
    expect(shouldSkipReviewForDiffSize(5 * 1024 * 1024)).toBe(false);
  });

  it('skips review when diff size exceeds the 5MB limit', () => {
    expect(shouldSkipReviewForDiffSize(5 * 1024 * 1024 + 1)).toBe(true);
    expect(shouldSkipReviewForDiffSize(6 * 1024 * 1024)).toBe(true);
  });
});
