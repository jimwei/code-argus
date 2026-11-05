import { z } from 'zod';
import type { RuntimeToolDefinition } from '../runtime/types.js';

export function parseIgnoreCoverageWarnings(
  value?: string,
  source = 'ARGUS_IGNORE_COVERAGE_WARNINGS'
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`Invalid ${source}: expected true or false`);
}

export function resolveIgnoreCoverageWarnings(explicit?: boolean): boolean {
  return explicit ?? parseIgnoreCoverageWarnings(process.env.ARGUS_IGNORE_COVERAGE_WARNINGS);
}

export function buildCoverageWarningPolicy(ignoreCoverageWarnings = true): string {
  return `## Review coverage policy

Use report_incomplete with a reason for explicit review coverage gaps. Report concrete findings normally through report_issue, including warning-severity findings. Authentication, network, runtime, tool, cancellation, turn/token budget, validator and fix-verification failures must retain their normal failure handling; report_incomplete cannot turn them into a successful review.
${
  ignoreCoverageWarnings
    ? 'Ignoring coverage warnings is ENABLED. All explicit report_incomplete coverage warnings are ignored regardless of the reason. Do not report coverage gaps as ordinary report_issue findings or summary warnings to bypass this setting. Continue reviewing available code and report supported findings normally; ignoring coverage warnings does not establish that unreviewed code is safe.'
    : 'Ignoring coverage warnings is DISABLED. Explicit report_incomplete coverage gaps mark the review incomplete, regardless of the reason.'
}`;
}

export function createCoverageWarningTool(
  ignoreCoverageWarnings: boolean,
  onWarning: (reason: string) => void
): RuntimeToolDefinition<{ reason: string }> {
  return {
    name: 'report_incomplete',
    description:
      'Report missing evidence that prevents completing the review. This records a coverage warning unless coverage warnings are configured to be ignored. Runtime and budget failures retain their normal failure handling.',
    inputSchema: {
      reason: z.string().min(1).describe('Unresolved hypothesis and missing evidence'),
    },
    execute: async (args) => {
      if (!ignoreCoverageWarnings)
        onWarning(args.reason || 'Reviewer could not complete the review');
      return {
        content: [
          {
            type: 'text',
            text: ignoreCoverageWarnings
              ? 'Coverage warning ignored by configuration. Continue reviewing available code and report concrete findings normally.'
              : 'Incomplete review recorded. Finish with a brief summary.',
          },
        ],
      };
    },
  };
}
