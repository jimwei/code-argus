/**
 * Validation tuning: challenge rounds, per-issue turn budget and Read window.
 *
 * Defaults stay unchanged when nothing is configured:
 * - rounds: fast mode 2, normal mode 5
 * - turn budget: 30 per issue
 * - Read window: 140 lines per call (cap 180)
 */
export interface ValidationTuningOptions {
  rounds?: number;
  maxTurns?: number;
  readLimit?: number;
}

const ROUNDS_MIN = 1;
const ROUNDS_MAX = 5;
const TURNS_MIN = 1;
const TURNS_MAX = 300;
const READ_LIMIT_MIN = 60;
const READ_LIMIT_MAX = 2000;

function parseInteger(
  raw: string | number | undefined,
  min: number,
  max: number,
  label: string
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const text = typeof raw === 'number' ? raw : raw.trim();
  if (text === '') {
    return undefined;
  }
  const value = typeof text === 'number' ? text : Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Invalid ${label} "${String(raw)}": expected an integer between ${min} and ${max}`
    );
  }
  return value;
}

/** Challenge rounds per issue (1..5). Empty values mean "use the mode default". */
export function parseValidationRounds(raw?: string | number): number | undefined {
  return parseInteger(raw, ROUNDS_MIN, ROUNDS_MAX, 'validation rounds');
}

/** Explicit per-issue validation turn budget (1..300). */
export function parseValidationMaxTurns(raw?: string | number): number | undefined {
  return parseInteger(raw, TURNS_MIN, TURNS_MAX, 'validation max turns');
}

/** Max lines the validator Read tool returns per call (60..2000). */
export function parseValidationReadLimit(raw?: string | number): number | undefined {
  return parseInteger(raw, READ_LIMIT_MIN, READ_LIMIT_MAX, 'validation read limit');
}

/**
 * Resolve validation tuning with CLI/options taking precedence over the
 * ARGUS_VALIDATION_* environment values.
 */
export function resolveValidationTuning(
  options: ValidationTuningOptions = {},
  env: NodeJS.ProcessEnv = process.env
): ValidationTuningOptions {
  return {
    rounds:
      options.rounds !== undefined
        ? parseValidationRounds(options.rounds)
        : parseValidationRounds(env.ARGUS_VALIDATION_ROUNDS),
    maxTurns:
      options.maxTurns !== undefined
        ? parseValidationMaxTurns(options.maxTurns)
        : parseValidationMaxTurns(env.ARGUS_VALIDATION_MAX_TURNS),
    readLimit:
      options.readLimit !== undefined
        ? parseValidationReadLimit(options.readLimit)
        : parseValidationReadLimit(env.ARGUS_VALIDATION_READ_LIMIT),
  };
}
