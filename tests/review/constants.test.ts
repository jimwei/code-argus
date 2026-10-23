import { describe, expect, it } from 'vitest';
import { getRecommendedMaxTurns } from '../../src/review/constants.js';

describe('getRecommendedMaxTurns', () => {
  it('uses the conservative base/minimum budget', () => {
    expect(getRecommendedMaxTurns(1)).toBe(15);
    expect(getRecommendedMaxTurns(4)).toBe(18);
    expect(getRecommendedMaxTurns(5)).toBe(20);
  });

  it('still clamps invalid input to the minimum', () => {
    expect(getRecommendedMaxTurns(Number.NaN)).toBe(15);
    expect(getRecommendedMaxTurns(-1)).toBe(15);
  });
});
