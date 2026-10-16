import { describe, expect, it } from 'vitest';
import {
  parseValidationMaxTurns,
  parseValidationReadLimit,
  parseValidationRounds,
  resolveValidationTuning,
} from '../../src/review/validation-config.js';

describe('validation tuning config', () => {
  it('parses challenge rounds within 1..5', () => {
    expect(parseValidationRounds(undefined)).toBeUndefined();
    expect(parseValidationRounds('')).toBeUndefined();
    expect(parseValidationRounds('  ')).toBeUndefined();
    expect(parseValidationRounds('1')).toBe(1);
    expect(parseValidationRounds(5)).toBe(5);
    for (const invalid of ['0', '6', '1.5', 'two']) {
      expect(() => parseValidationRounds(invalid)).toThrow(/validation rounds/i);
    }
  });

  it('parses the per-issue turn budget and Read window', () => {
    expect(parseValidationMaxTurns(undefined)).toBeUndefined();
    expect(parseValidationMaxTurns('15')).toBe(15);
    expect(parseValidationMaxTurns(300)).toBe(300);
    for (const invalid of ['0', '301', '1.5']) {
      expect(() => parseValidationMaxTurns(invalid)).toThrow(/validation max turns/i);
    }
    expect(parseValidationReadLimit(undefined)).toBeUndefined();
    expect(parseValidationReadLimit('400')).toBe(400);
    for (const invalid of ['59', '2001', 'abc']) {
      expect(() => parseValidationReadLimit(invalid)).toThrow(/validation read limit/i);
    }
  });

  it('prefers explicit options over environment values', () => {
    const env = {
      ARGUS_VALIDATION_ROUNDS: '1',
      ARGUS_VALIDATION_MAX_TURNS: '15',
      ARGUS_VALIDATION_READ_LIMIT: '400',
    };
    expect(resolveValidationTuning({}, env)).toEqual({ rounds: 1, maxTurns: 15, readLimit: 400 });
    expect(resolveValidationTuning({ rounds: 3, maxTurns: 20 }, env)).toEqual({
      rounds: 3,
      maxTurns: 20,
      readLimit: 400,
    });
    expect(resolveValidationTuning({}, {})).toEqual({
      rounds: undefined,
      maxTurns: undefined,
      readLimit: undefined,
    });
  });

  it('rejects invalid environment values instead of silently ignoring them', () => {
    expect(() => resolveValidationTuning({}, { ARGUS_VALIDATION_ROUNDS: '9' })).toThrow(
      /validation rounds/i
    );
    expect(() => resolveValidationTuning({}, { ARGUS_VALIDATION_READ_LIMIT: '10' })).toThrow(
      /validation read limit/i
    );
  });
});
