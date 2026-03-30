import { getMinConfidenceForValidation } from './constants.js';
import type { RawIssue, ValidatedIssue } from './types.js';

const LOW_SIGNAL_SUGGESTION_CATEGORIES = new Set(['style', 'maintainability', 'performance']);
const STRICT_WARNING_CATEGORIES = new Set(['style', 'maintainability']);

const STRICT_WARNING_MIN_CONFIDENCE = 0.75;
const STRICT_WARNING_REPORT_CONFIDENCE = 0.8;
const SOFT_WARNING_MAX_CHALLENGE_ROUNDS = 2;

export interface HighSignalValidationPolicy {
  shouldValidate: boolean;
  minConfidence: number;
  maxChallengeRounds: number;
  rejectionReason?: string;
}

export function getHighSignalValidationPolicy(
  issue: Pick<RawIssue, 'category' | 'severity'>,
  defaultMaxChallengeRounds: number
): HighSignalValidationPolicy {
  if (isLowSignalSuggestion(issue)) {
    return {
      shouldValidate: false,
      minConfidence: 1,
      maxChallengeRounds: 0,
      rejectionReason: '低信号软建议：默认不进入验证或最终报告',
    };
  }

  if (isStrictSoftWarning(issue)) {
    return {
      shouldValidate: true,
      minConfidence: STRICT_WARNING_MIN_CONFIDENCE,
      maxChallengeRounds: Math.min(defaultMaxChallengeRounds, SOFT_WARNING_MAX_CHALLENGE_ROUNDS),
    };
  }

  return {
    shouldValidate: true,
    minConfidence: getMinConfidenceForValidation(issue.severity),
    maxChallengeRounds: defaultMaxChallengeRounds,
  };
}

export function shouldIncludeIssueInFinalReport(
  issue: Pick<ValidatedIssue, 'category' | 'severity' | 'final_confidence'>
): boolean {
  if (isLowSignalSuggestion(issue)) {
    return false;
  }

  if (isStrictSoftWarning(issue) && issue.final_confidence < STRICT_WARNING_REPORT_CONFIDENCE) {
    return false;
  }

  return true;
}

function isLowSignalSuggestion(issue: Pick<RawIssue, 'category' | 'severity'>): boolean {
  return issue.severity === 'suggestion' && LOW_SIGNAL_SUGGESTION_CATEGORIES.has(issue.category);
}

function isStrictSoftWarning(issue: Pick<RawIssue, 'category' | 'severity'>): boolean {
  return issue.severity === 'warning' && STRICT_WARNING_CATEGORIES.has(issue.category);
}
