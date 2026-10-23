import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VALIDATOR_TOOL_CALL_BUDGET,
  getRecommendedMaxTurns,
  getValidatorToolCallBudget,
} from '../../src/review/constants.js';

describe('getValidatorToolCallBudget', () => {
  it('defaults to the bounded exploration budget', () => {
    const previous = process.env.ARGUS_VALIDATOR_TOOL_BUDGET;
    delete process.env.ARGUS_VALIDATOR_TOOL_BUDGET;
    try {
      expect(getValidatorToolCallBudget()).toBe(DEFAULT_VALIDATOR_TOOL_CALL_BUDGET);
      expect(DEFAULT_VALIDATOR_TOOL_CALL_BUDGET).toBeGreaterThan(0);
    } finally {
      if (previous !== undefined) {
        process.env.ARGUS_VALIDATOR_TOOL_BUDGET = previous;
      }
    }
  });

  it('honours the env override, including disabling with 0', () => {
    const previous = process.env.ARGUS_VALIDATOR_TOOL_BUDGET;
    try {
      process.env.ARGUS_VALIDATOR_TOOL_BUDGET = '8';
      expect(getValidatorToolCallBudget()).toBe(8);
      process.env.ARGUS_VALIDATOR_TOOL_BUDGET = '0';
      expect(getValidatorToolCallBudget()).toBe(0);
      process.env.ARGUS_VALIDATOR_TOOL_BUDGET = 'not-a-number';
      expect(getValidatorToolCallBudget()).toBe(DEFAULT_VALIDATOR_TOOL_CALL_BUDGET);
    } finally {
      if (previous === undefined) {
        delete process.env.ARGUS_VALIDATOR_TOOL_BUDGET;
      } else {
        process.env.ARGUS_VALIDATOR_TOOL_BUDGET = previous;
      }
    }
  });
});

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
