import { describe, expect, it } from 'vitest';
import { getRecommendedMaxTurns } from '../../src/review/constants.js';

describe('getRecommendedMaxTurns', () => {
  it('uses the new higher base/minimum budget', () => {
    expect(getRecommendedMaxTurns(1)).toBe(24);
    expect(getRecommendedMaxTurns(4)).toBe(28);
    expect(getRecommendedMaxTurns(5)).toBe(31);
  });

  it('still clamps invalid input to the minimum', () => {
    expect(getRecommendedMaxTurns(Number.NaN)).toBe(24);
    expect(getRecommendedMaxTurns(-1)).toBe(24);
  });
});
