/**
 * Fix Verifier Agent Executor
 *
 * Runs the fix-verifier agent to check if issues from a previous review
 * have been properly addressed in the current changes.
 */

import { createRuntimeFromEnv } from '../runtime/factory.js';
import { createRepoContextTools } from '../runtime/repo-context-tools.js';
import type { RuntimeExecution, RuntimeToolDefinition } from '../runtime/types.js';
import { z } from 'zod';
import type {
  PreviousReviewData,
  FixVerificationResult,
  FixVerificationSummary,
  VerificationStatus,
  FixVerificationEvidence,
} from './types.js';
import type { IProgressPrinter } from '../cli/index.js';

/**
 * Screening result from Phase 1
 */
interface ScreeningResult {
  issue_id: string;
  screening_status: 'resolved' | 'unresolved' | 'unclear';
  quick_reasoning: string;
}

interface ScreeningResultToolArgs {
  issue_id: string;
  screening_status: 'resolved' | 'unresolved' | 'unclear';
  quick_reasoning: string;
}

interface UpdatedIssueToolArgs {
  title: string;
  description: string;
  suggestion?: string;
}

interface VerificationResultToolArgs {
  issue_id: string;
  status: VerificationStatus;
  confidence: number;
  evidence: FixVerificationEvidence;
  updated_issue?: UpdatedIssueToolArgs;
  false_positive_reason?: string;
  notes?: string;
}

/**
 * Options for fix verifier
 */
export interface FixVerifierOptions {
  /** Repository path (worktree path for agent to work in) */
  repoPath: string;
  /** Previous review data containing issues to verify */
  previousReview: PreviousReviewData;
  /** Diff content for context */
  diffContent: string;
  /** Summary of file changes */
  fileChangesSummary: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Progress printer for status updates */
  progress?: IProgressPrinter;
  /** Output language for review comments */
  language?: 'en' | 'zh';
  /** Callbacks for real-time updates */
  callbacks?: {
    onScreeningComplete?: (issueId: string, status: string) => void;
    onVerificationComplete?: (result: FixVerificationResult) => void;
  };
}

/**
 * Execute fix verifier agent
 *
 * @param options - Fix verifier options
 * @returns Fix verification summary with all results
 */
export async function executeFixVerifier(
  options: FixVerifierOptions
): Promise<FixVerificationSummary> {
  const startTime = Date.now();
  const screeningResults: ScreeningResult[] = [];
  const verificationResults: FixVerificationResult[] = [];
  let inputTokensUsed = 0;
  let outputTokensUsed = 0;
  let tokensUsed = 0;
  const langLabel = (options.language ?? 'zh') === 'en' ? 'English' : 'Chinese';

  const { previousReview, repoPath, verbose, progress, callbacks } = options;

  if (verbose) {
    console.log(`[FixVerifier] Starting verification of ${previousReview.issues.length} issues...`);
  }

  progress?.info(`Starting fix verification for ${previousReview.issues.length} issues...`);

  const runtime = createRuntimeFromEnv();
  const repoContextTools =
    runtime.kind === 'openai-responses' ? createRepoContextTools(repoPath) : [];
  const runtimeTools: RuntimeToolDefinition<any>[] = [
    {
      name: 'report_screening_result',
      description: `Report quick screening result for an issue (Phase 1).
Call this for EACH issue after initial screening.`,
      inputSchema: {
        issue_id: z.string().describe('Original issue ID'),
        screening_status: z
          .enum(['resolved', 'unresolved', 'unclear'])
          .describe('Screening status'),
        quick_reasoning: z.string().describe(`Brief explanation in ${langLabel}`),
      },
      execute: async (args: ScreeningResultToolArgs) => {
        if (verbose) {
          console.log(`[FixVerifier] Screening: ${args.issue_id} -> ${args.screening_status}`);
        }

        screeningResults.push({
          issue_id: args.issue_id,
          screening_status: args.screening_status,
          quick_reasoning: args.quick_reasoning,
        });

        callbacks?.onScreeningComplete?.(args.issue_id, args.screening_status);

        const originalIssue = previousReview.issues.find((issue) => issue.id === args.issue_id);
        const issueTitle = originalIssue?.title || args.issue_id;
        progress?.info(`Screening: ${args.screening_status} ${issueTitle}`);

        return {
          content: [
            {
              type: 'text' as const,
              text: `Screening recorded: ${args.issue_id} -> ${args.screening_status}`,
            },
          ],
        };
      },
    },
    {
      name: 'report_verification_result',
      description: `Report final verification result for an issue (Phase 2).
Call this after deep investigation of unresolved/unclear issues.`,
      inputSchema: {
        issue_id: z.string().describe('Original issue ID'),
        status: z
          .enum(['fixed', 'missed', 'false_positive', 'obsolete', 'uncertain'])
          .describe('Final verification status'),
        confidence: z.number().min(0).max(1).describe('Confidence in the verdict (0-1)'),
        evidence: z
          .object({
            checked_files: z.array(z.string()).describe('Files that were checked'),
            examined_code: z.array(z.string()).describe('Code snippets examined'),
            related_changes: z.string().describe('Summary of related changes found'),
            reasoning: z.string().describe(`Detailed reasoning in ${langLabel}`),
          })
          .describe('Evidence collected during verification'),
        updated_issue: z
          .object({
            title: z.string().describe('Updated issue title'),
            description: z.string().describe('Updated issue description'),
            suggestion: z.string().optional().describe('Updated fix suggestion'),
          })
          .optional()
          .describe('Updated issue details (only if status is missed)'),
        false_positive_reason: z
          .string()
          .optional()
          .describe('Explanation (only if status is false_positive)'),
        notes: z.string().optional().describe('Additional notes'),
      },
      execute: async (args: VerificationResultToolArgs) => {
        const originalIssue = previousReview.issues.find((issue) => issue.id === args.issue_id);

        if (!originalIssue) {
          return {
            content: [{ type: 'text' as const, text: `Unknown issue ID: ${args.issue_id}` }],
          };
        }

        const result: FixVerificationResult = {
          original_issue_id: args.issue_id,
          original_issue: originalIssue,
          status: args.status,
          confidence: args.confidence,
          evidence: args.evidence,
          false_positive_reason: args.false_positive_reason,
          notes: args.notes,
        };

        if (args.status === 'missed' && args.updated_issue) {
          result.updated_issue = {
            id: `${args.issue_id}-updated`,
            file: originalIssue.file,
            line_start: originalIssue.line_start,
            line_end: originalIssue.line_end,
            category: originalIssue.category,
            severity: originalIssue.severity,
            title: args.updated_issue.title,
            description: args.updated_issue.description,
            suggestion: args.updated_issue.suggestion,
            confidence: args.confidence,
            source_agent: 'fix-verifier',
          };
        }

        verificationResults.push(result);
        callbacks?.onVerificationComplete?.(result);

        if (verbose) {
          console.log(`[FixVerifier] Verified: ${args.issue_id} -> ${args.status}`);
        }

        progress?.success(
          `Verification: ${getStatusEmoji(args.status)} ${originalIssue.title} -> ${getStatusText(args.status)}`
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: `Verification recorded: ${args.issue_id} -> ${args.status} (${Math.round(args.confidence * 100)}%)`,
            },
          ],
        };
      },
    },
    ...repoContextTools,
  ];

  const systemPrompt = buildFixVerifierSystemPrompt(options.language);
  const userPrompt = buildFixVerifierUserPrompt(options);
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

  let execution: RuntimeExecution | null = null;
  let sigtermHandler: (() => void) | null = null;
  let sigintHandler: (() => void) | null = null;

  try {
    execution = runtime.execute({
      prompt: fullPrompt,
      cwd: repoPath,
      maxTurns: Math.max(30, previousReview.issues.length * 5),
      model: runtime.config.models.validator,
      tools: runtimeTools,
      toolNamespace: 'fix-verifier-tools',
    });

    let isCleaningUp = false;
    const cleanupAndExit = async (signal: string) => {
      if (isCleaningUp || !execution) return;
      isCleaningUp = true;
      console.log(`[FixVerifier] Received ${signal}, cleaning up...`);
      try {
        await execution.close();
      } catch {
        // Ignore shutdown cleanup errors.
      }
      process.exit(0);
    };
    sigtermHandler = () => cleanupAndExit('SIGTERM');
    sigintHandler = () => cleanupAndExit('SIGINT');
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);

    for await (const event of execution) {
      if (event.type !== 'result') {
        continue;
      }

      if (event.usage) {
        inputTokensUsed = event.usage.inputTokens;
        outputTokensUsed = event.usage.outputTokens;
        tokensUsed = inputTokensUsed + outputTokensUsed;
      }

      if (event.status !== 'success' && verbose) {
        console.error(`[FixVerifier] Runtime result status: ${event.status}`, event.error);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[FixVerifier] Error during verification: ${errorMessage}`);
    progress?.error(`Fix verification failed: ${errorMessage}`);
  } finally {
    if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
    if (sigintHandler) process.off('SIGINT', sigintHandler);

    if (execution) {
      try {
        await execution.close();
      } catch (cleanupError) {
        if (verbose) {
          console.warn(`[FixVerifier] Cleanup warning:`, cleanupError);
        }
      }
    }
  }

  for (const screening of screeningResults) {
    if (
      verificationResults.some(
        (verification) => verification.original_issue_id === screening.issue_id
      )
    ) {
      continue;
    }

    const originalIssue = previousReview.issues.find((issue) => issue.id === screening.issue_id);
    if (!originalIssue) continue;

    if (screening.screening_status === 'resolved') {
      verificationResults.push({
        original_issue_id: screening.issue_id,
        original_issue: originalIssue,
        status: 'fixed',
        confidence: 0.8,
        evidence: {
          checked_files: [],
          examined_code: [],
          related_changes: '',
          reasoning: screening.quick_reasoning,
        },
      });
    }
  }

  const byStatus: Record<VerificationStatus, number> = {
    fixed: 0,
    missed: 0,
    false_positive: 0,
    obsolete: 0,
    uncertain: 0,
  };

  for (const result of verificationResults) {
    byStatus[result.status]++;
  }

  const summary: FixVerificationSummary = {
    total_verified: verificationResults.length,
    by_status: byStatus,
    results: verificationResults,
    verification_time_ms: Date.now() - startTime,
    input_tokens_used: inputTokensUsed,
    output_tokens_used: outputTokensUsed,
    tokens_used: tokensUsed,
  };

  if (verbose) {
    console.log(`[FixVerifier] Completed. Results:`, byStatus);
  }

  progress?.success(
    `Fix verification complete: ${byStatus.fixed} fixed, ${byStatus.missed} missed, ${byStatus.false_positive} false positive`
  );

  return summary;
}

/**
 * Build system prompt for fix verifier agent
 */
function buildFixVerifierSystemPrompt(language: 'en' | 'zh' = 'zh'): string {
  return `You are a Fix Verification Specialist. Your task is to verify whether code issues identified in a previous review have been properly addressed in the current changes.

## Your Mission

For each issue from the previous review, determine its current status through a TWO-PHASE PROCESS:

### Phase 1: Batch Initial Screening (批量初筛)
Quickly scan ALL issues and categorize each as:
- **resolved**: Clear evidence the issue has been fixed
- **unresolved**: Issue still exists or fix is incomplete
- **unclear**: Need deeper investigation

Use the \`report_screening_result\` tool for EACH issue.

### Phase 2: Deep Investigation (深入验证)
For issues marked as **unresolved** or **unclear**, conduct thorough investigation:
1. Confirm if the issue truly still exists
2. Determine if it's a genuine miss or a false positive
3. If missed, provide updated issue description

Use the \`report_verification_result\` tool for each deeply investigated issue.

## Verification Status Definitions

- **fixed**: Issue has been properly addressed
- **missed**: Issue still exists (developer oversight)
- **false_positive**: Original detection was wrong
- **obsolete**: Code changed so much the issue is no longer relevant
- **uncertain**: Cannot determine with confidence

## Important Guidelines

1. Complete ALL Phase 1 screenings first, then proceed to Phase 2
2. Be thorough but efficient - Phase 1 should be quick
3. Provide evidence for all conclusions
4. All text output (reasoning, descriptions) must be in ${language === 'en' ? 'English' : 'Chinese'}
5. Be fair - some original issues may have been false positives`;
}

/**
 * Build user prompt for fix verifier agent
 */
function buildFixVerifierUserPrompt(options: FixVerifierOptions): string {
  const { previousReview, diffContent, fileChangesSummary } = options;

  // Format issues list
  const issuesList = previousReview.issues
    .map((issue, idx) => {
      return `### Issue #${idx + 1}: ${issue.id}
**File**: \`${issue.file}\` (lines ${issue.line_start}-${issue.line_end})
**Severity**: ${issue.severity} | **Category**: ${issue.category}
**Title**: ${issue.title}
**Description**: ${issue.description}
${issue.suggestion ? `**Suggestion**: ${issue.suggestion}` : ''}
${issue.code_snippet ? `**Original Code**:\n\`\`\`\n${issue.code_snippet}\n\`\`\`` : ''}`;
    })
    .join('\n\n---\n\n');

  // Truncate diff if too long
  const maxDiffLength = 50000;
  const truncatedDiff =
    diffContent.length > maxDiffLength
      ? diffContent.slice(0, maxDiffLength) + '\n... (truncated)'
      : diffContent;

  return `# Fix Verification Task

## Previous Review Issues to Verify

Total issues: ${previousReview.issues.length}

${issuesList}

## Current Diff (What Changed)

\`\`\`diff
${truncatedDiff}
\`\`\`

## File Changes Summary

${fileChangesSummary || 'No summary available.'}

## Instructions

Please follow the two-phase verification process:

**Phase 1: Batch Screening**
1. Quickly scan all ${previousReview.issues.length} issues
2. For each issue, use \`report_screening_result\` to classify as resolved/unresolved/unclear
3. Be efficient - spend ~30 seconds per issue in this phase

**Phase 2: Deep Investigation**
1. For issues marked as "unresolved" or "unclear" in Phase 1, conduct thorough investigation
2. Use Read, Grep, Glob tools to gather evidence
3. Determine if it's a "missed fix" or "false positive"
4. Use \`report_verification_result\` to report final status

Begin with Phase 1 now.`;
}

/**
 * Get emoji for verification status
 */
function getStatusEmoji(status: VerificationStatus): string {
  switch (status) {
    case 'fixed':
      return '✅';
    case 'missed':
      return '🔴';
    case 'false_positive':
      return '🟡';
    case 'obsolete':
      return '⚪';
    case 'uncertain':
      return '❓';
  }
}

/**
 * Get Chinese text for verification status
 */
function getStatusText(status: VerificationStatus): string {
  switch (status) {
    case 'fixed':
      return '已修复';
    case 'missed':
      return '未修复';
    case 'false_positive':
      return '误报';
    case 'obsolete':
      return '已过时';
    case 'uncertain':
      return '不确定';
  }
}
