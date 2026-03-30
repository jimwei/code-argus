/**
 * Streaming Validator
 *
 * Validates issues in a streaming fashion - as issues are discovered by agents,
 * they are immediately queued for validation. Each file gets a dedicated session
 * that processes issues one by one, reusing the session context.
 *
 * Key features:
 * 1. Stream processing - validation starts as soon as issues arrive
 * 2. Session reuse - same file issues share a session (file read only once)
 * 3. Sequential validation per file - one issue at a time for better focus
 * 4. Concurrent sessions - multiple files validated in parallel
 */

import { createRuntimeFromEnv } from '../runtime/factory.js';
import type { RuntimeExecution } from '../runtime/types.js';
import type { RawIssue, ValidatedIssue, SymbolLookup, ValidationStatus } from './types.js';
import {
  DEFAULT_VALIDATOR_MAX_TURNS,
  DEFAULT_CHALLENGE_MODE,
  MAX_CHALLENGE_ROUNDS,
  FAST_MODE_CHALLENGE_ROUNDS,
  MIN_CONFIDENCE_FOR_VALIDATION,
  getValidatorMaxTurns,
} from './constants.js';
import { extractJSON } from './utils/json-parser.js';
import { buildValidationSystemPrompt } from './prompts/validation.js';
import { getHighSignalValidationPolicy } from './high-signal-policy.js';

/** Maximum number of times to retry a crashed session */
const MAX_SESSION_CRASH_RETRIES = 2;

/**
 * Progress callback for streaming validation (legacy)
 */
export type StreamingValidationProgressCallback = (
  completedCount: number,
  totalCount: number,
  issueId: string,
  status: ValidationStatus
) => void;

/**
 * Detailed progress callbacks for streaming validation
 */
export interface StreamingValidationCallbacks {
  /** Called when an issue is discovered (before validation) */
  onIssueDiscovered?: (issue: RawIssue) => void;
  /** Called when an issue is validated */
  onIssueValidated?: (issue: ValidatedIssue) => void;
  /** Called when an issue is auto-rejected */
  onAutoRejected?: (issue: RawIssue, reason: string) => void;
  /** Called when validation round completes for an issue */
  onRoundComplete?: (
    issueId: string,
    issueTitle: string,
    round: number,
    maxRounds: number,
    status: ValidationStatus
  ) => void;
  /** Called periodically to show validation is still active (heartbeat) */
  onValidationActivity?: (issueId: string, issueTitle: string, activity: string) => void;
}

/**
 * Streaming validator options
 */
export interface StreamingValidatorOptions {
  /** Repository path */
  repoPath: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Maximum turns for validation */
  maxTurns?: number;
  /** Progress callback (legacy) */
  onProgress?: StreamingValidationProgressCallback;
  /** Detailed progress callbacks */
  callbacks?: StreamingValidationCallbacks;
  /** Enable challenge mode */
  challengeMode?: boolean;
  /** Maximum concurrent file sessions */
  maxConcurrentSessions?: number;
  /** Session idle timeout in ms (close session if no new issues) */
  sessionIdleTimeoutMs?: number;
  /** Project-specific review rules (markdown format) */
  projectRules?: string;
  /** Maximum challenge rounds per issue (default: MAX_CHALLENGE_ROUNDS) */
  maxChallengeRounds?: number;
  /** Use fast mode validation prompt (self-challenge in single round) */
  fastMode?: boolean;
  /** Output language for review comments */
  language?: 'en' | 'zh';
}

/**
 * Resolved options with defaults
 */
interface ResolvedOptions {
  repoPath: string;
  verbose: boolean;
  maxTurns: number;
  onProgress?: StreamingValidationProgressCallback;
  callbacks?: StreamingValidationCallbacks;
  challengeMode: boolean;
  maxConcurrentSessions: number;
  sessionIdleTimeoutMs: number;
  projectRules?: string;
  maxChallengeRounds: number;
  fastMode: boolean;
  language: 'en' | 'zh';
}

/**
 * Parsed validation response
 */
interface ParsedValidationResponse {
  validation_status: 'confirmed' | 'rejected' | 'uncertain';
  final_confidence: number;
  grounding_evidence: {
    checked_files: string[];
    checked_symbols: SymbolLookup[];
    related_context: string;
    reasoning: string;
  };
  rejection_reason?: string;
  revised_description?: string;
  revised_severity?: 'critical' | 'error' | 'warning' | 'suggestion';
}

/**
 * File validation session state
 */
interface FileSession {
  /** File path */
  file: string;
  /** Issue queue waiting to be validated */
  queue: RawIssue[];
  /** Currently processing */
  isProcessing: boolean;
  /** Session is closed */
  isClosed: boolean;
  /** Tokens used by this session */
  tokensUsed: number;
  /** Validated issues from this session */
  results: ValidatedIssue[];
  /** Idle timeout handle */
  idleTimeout?: ReturnType<typeof globalThis.setTimeout>;
  /** Promise that resolves when session finishes all queued work */
  processingPromise?: Promise<void>;
  /** Function to signal new issue added */
  notifyNewIssue?: () => void;
  /** Number of crash retries for this session */
  crashRetryCount?: number;
}

interface RuntimePromptMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Streaming Validator
 *
 * Manages file-based validation sessions that process issues as they arrive.
 */
export class StreamingValidator {
  private options: ResolvedOptions;
  private sessions: Map<string, FileSession> = new Map();
  private completedCount = 0;
  private totalEnqueued = 0;
  private allAgentsComplete = false;

  constructor(options: StreamingValidatorOptions) {
    const fastMode = options.fastMode ?? false;
    this.options = {
      verbose: options.verbose ?? false,
      maxTurns: options.maxTurns ?? DEFAULT_VALIDATOR_MAX_TURNS,
      challengeMode: options.challengeMode ?? DEFAULT_CHALLENGE_MODE,
      maxConcurrentSessions: options.maxConcurrentSessions ?? 5,
      sessionIdleTimeoutMs: options.sessionIdleTimeoutMs ?? 30000, // 30s default
      repoPath: options.repoPath,
      onProgress: options.onProgress,
      callbacks: options.callbacks,
      projectRules: options.projectRules,
      maxChallengeRounds:
        options.maxChallengeRounds ??
        (fastMode ? FAST_MODE_CHALLENGE_ROUNDS : MAX_CHALLENGE_ROUNDS),
      fastMode,
      language: options.language ?? 'zh',
    };
  }

  /**
   * Enqueue an issue for validation
   *
   * Called by agents as they discover issues. The issue will be:
   * 1. Filtered by confidence (auto-reject if too low)
   * 2. Added to the file's session queue
   * 3. Processed when the session is ready
   */
  enqueue(issue: RawIssue): ValidatedIssue | null {
    // Notify issue discovered
    this.options.callbacks?.onIssueDiscovered?.(issue);

    const validationPolicy = getHighSignalValidationPolicy(issue, this.options.maxChallengeRounds);
    const shouldRejectByConfidence =
      issue.severity !== 'critical' && issue.confidence < validationPolicy.minConfidence;

    if (!validationPolicy.shouldValidate || shouldRejectByConfidence) {
      const rejectionReason =
        validationPolicy.rejectionReason ||
        `置信度过低 (${issue.confidence} < ${validationPolicy.minConfidence})`;
      const rejected = this.createAutoRejectedIssue(issue, rejectionReason);
      rejected.grounding_evidence.related_context = rejectionReason;
      rejected.grounding_evidence.reasoning = rejectionReason;
      rejected.rejection_reason = rejectionReason;
      this.completedCount++;
      this.totalEnqueued++;

      // Notify via callbacks
      this.options.callbacks?.onAutoRejected?.(issue, rejectionReason);

      if (this.options.onProgress) {
        this.options.onProgress(this.completedCount, this.totalEnqueued, issue.id, 'rejected');
      }

      if (this.options.verbose) {
        console.log(`[StreamingValidator] Auto-rejected ${issue.id}: ${rejectionReason}`);
      }

      return rejected;
    }

    this.totalEnqueued++;

    // Get or create session for this file
    const session = this.getOrCreateSession(issue.file);

    // Add to queue
    session.queue.push(issue);

    if (this.options.verbose) {
      console.log(
        `[StreamingValidator] Enqueued ${issue.id} to ${issue.file} (queue size: ${session.queue.length})`
      );
    }

    // Clear idle timeout if set
    if (session.idleTimeout) {
      globalThis.clearTimeout(session.idleTimeout);
      session.idleTimeout = undefined;
    }

    // Notify session if it's waiting for new issues
    if (session.notifyNewIssue) {
      session.notifyNewIssue();
    }

    // Start processing if not already
    if (!session.isProcessing && !session.isClosed) {
      this.startSessionProcessing(session);
    }

    return null; // Will be available later via flush()
  }

  /**
   * Signal that all agents have completed
   *
   * After this, sessions will close when their queues are empty
   * instead of waiting for new issues.
   */
  markAgentsComplete(): void {
    this.allAgentsComplete = true;

    if (this.options.verbose) {
      console.log('[StreamingValidator] All agents complete, sessions will close when idle');
    }

    // Notify all waiting sessions
    for (const session of this.sessions.values()) {
      if (session.notifyNewIssue) {
        session.notifyNewIssue();
      }
    }
  }

  /**
   * Wait for all validation to complete and return results
   * @param timeoutMs Optional timeout in milliseconds (default: 30 minutes)
   */
  async flush(
    timeoutMs: number = 1800000
  ): Promise<{ issues: ValidatedIssue[]; tokensUsed: number }> {
    this.markAgentsComplete();

    const startTime = Date.now();

    // Wait for all sessions to complete, including any recovery sessions
    // We need to loop because recovery sessions may be started during waiting
    while (true) {
      const activeSessions = Array.from(this.sessions.values()).filter(
        (s) => s.processingPromise && !s.isClosed
      );

      if (activeSessions.length === 0) {
        break;
      }

      // Check timeout before waiting
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        console.warn(
          `[StreamingValidator] Flush timed out after ${timeoutMs / 1000}s. Returning partial results.`
        );
        break;
      }

      // Wait for current active sessions with remaining timeout
      const remainingTimeout = timeoutMs - elapsed;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        globalThis.setTimeout(() => resolve('timeout'), remainingTimeout);
      });

      const sessionPromises = activeSessions.map((s) => s.processingPromise);

      const result = await Promise.race([
        Promise.all(sessionPromises).then(() => 'complete' as const),
        timeoutPromise,
      ]);

      if (result === 'timeout') {
        // Timeout during wait - don't print again, just break
        break;
      }

      // After sessions complete, check if any recovery sessions were started
      // The loop will continue if there are new active sessions
    }

    // Collect all results (including partial if timed out)
    const allIssues: ValidatedIssue[] = [];
    let totalTokens = 0;

    for (const session of this.sessions.values()) {
      allIssues.push(...session.results);
      totalTokens += session.tokensUsed;
    }

    if (this.options.verbose) {
      console.log(
        `[StreamingValidator] Flush complete: ${allIssues.length} issues, ${totalTokens} tokens`
      );
    }

    return {
      issues: allIssues,
      tokensUsed: totalTokens,
    };
  }

  /**
   * Get current stats
   */
  getStats(): { completed: number; total: number; activeSessions: number } {
    return {
      completed: this.completedCount,
      total: this.totalEnqueued,
      activeSessions: Array.from(this.sessions.values()).filter((s) => s.isProcessing).length,
    };
  }

  // ============ Private Methods ============

  private getOrCreateSession(file: string): FileSession {
    let session = this.sessions.get(file);
    if (!session) {
      session = {
        file,
        queue: [],
        isProcessing: false,
        isClosed: false,
        tokensUsed: 0,
        results: [],
      };
      this.sessions.set(file, session);
    }
    return session;
  }

  private startSessionProcessing(session: FileSession): void {
    if (session.isProcessing || session.isClosed) return;

    session.isProcessing = true;
    session.processingPromise = this.runSession(session);
  }

  /**
   * Run a file validation session
   *
   * This session will:
   * 1. Process issues one by one from the queue
   * 2. Reuse the same Claude session for all issues (file context preserved)
   * 3. Wait for new issues if queue is empty (unless agents are complete)
   * 4. Close when agents complete and queue is empty
   */
  private async runSession(session: FileSession): Promise<void> {
    if (this.options.verbose) {
      console.log(`[StreamingValidator] Starting session for ${session.file}`);
    }

    const runtime = createRuntimeFromEnv();
    const messageQueue: Array<RuntimePromptMessage | null> = [];
    let resolveNextMessage: ((msg: RuntimePromptMessage | null) => void) | null = null;

    let currentIssue: RawIssue | null = null;
    let currentRound = 0;
    let currentResponses: ParsedValidationResponse[] = [];

    const waitForNewIssue = (): Promise<boolean> => {
      return new Promise((resolve) => {
        if (session.queue.length > 0) {
          resolve(true);
          return;
        }

        if (this.allAgentsComplete) {
          resolve(false);
          return;
        }

        session.notifyNewIssue = () => {
          session.notifyNewIssue = undefined;
          if (session.queue.length > 0) {
            resolve(true);
          } else if (this.allAgentsComplete) {
            resolve(false);
          }
        };

        session.idleTimeout = globalThis.setTimeout(() => {
          if (this.options.verbose) {
            console.log(`[StreamingValidator] Session ${session.file} idle timeout`);
          }
          session.notifyNewIssue = undefined;
          resolve(false);
        }, this.options.sessionIdleTimeoutMs);
      });
    };

    const getNextIssue = async (): Promise<RawIssue | null> => {
      if (session.queue.length > 0) {
        return session.queue.shift()!;
      }

      const hasMore = await waitForNewIssue();
      if (hasMore && session.queue.length > 0) {
        return session.queue.shift()!;
      }

      return null;
    };

    const buildIssuePrompt = (issue: RawIssue, isFirst: boolean): string => {
      const systemPrompt = buildValidationSystemPrompt(issue.category, {
        projectRules: this.options.projectRules,
        fastMode: this.options.fastMode,
        language: this.options.language,
      });
      const userPrompt = this.buildUserPrompt(issue);

      if (isFirst) {
        return `${systemPrompt}\n\n${userPrompt}`;
      }

      return `Validate the next issue in the same file context.\n\n${userPrompt}`;
    };

    async function* messageGenerator(): AsyncGenerator<RuntimePromptMessage> {
      while (true) {
        const msg = await new Promise<RuntimePromptMessage | null>((resolve) => {
          if (messageQueue.length > 0) {
            resolve(messageQueue.shift() ?? null);
          } else {
            resolveNextMessage = resolve;
          }
        });

        if (msg === null) {
          return;
        }

        yield msg;
      }
    }

    const sendMessage = (content: string) => {
      if (session.isClosed) {
        return;
      }

      const msg: RuntimePromptMessage = {
        type: 'user',
        message: {
          role: 'user',
          content,
        },
        parent_tool_use_id: null,
        session_id: '',
      };

      if (resolveNextMessage) {
        const resolve = resolveNextMessage;
        resolveNextMessage = null;
        resolve(msg);
      } else {
        messageQueue.push(msg);
      }
    };

    const endSession = () => {
      if (session.isClosed) {
        return;
      }

      session.isClosed = true;

      if (resolveNextMessage) {
        const resolve = resolveNextMessage;
        resolveNextMessage = null;
        resolve(null);
      } else {
        messageQueue.push(null);
      }
    };

    const completeCurrentIssue = (validatedIssue: ValidatedIssue) => {
      session.results.push(validatedIssue);
      this.completedCount++;

      this.options.callbacks?.onIssueValidated?.(validatedIssue);

      if (this.options.onProgress) {
        this.options.onProgress(
          this.completedCount,
          this.totalEnqueued,
          validatedIssue.id,
          validatedIssue.validation_status
        );
      }

      if (this.options.verbose) {
        console.log(
          `[StreamingValidator] Completed ${validatedIssue.id}: ${validatedIssue.validation_status}`
        );
      }

      currentIssue = null;
      currentRound = 0;
      currentResponses = [];
    };

    const advanceToNextIssue = async () => {
      const nextIssue = await getNextIssue();
      if (!nextIssue) {
        endSession();
        return false;
      }

      currentIssue = nextIssue;
      currentRound = 1;
      currentResponses = [];
      sendMessage(buildIssuePrompt(nextIssue, false));
      return true;
    };

    currentIssue = await getNextIssue();
    if (!currentIssue) {
      session.isProcessing = false;
      session.isClosed = true;
      return;
    }

    const firstPrompt = buildIssuePrompt(currentIssue, true);
    currentRound = 1;

    const estimatedIssueCount = Math.max(session.queue.length + 1, 5);
    const dynamicMaxTurns = getValidatorMaxTurns(
      estimatedIssueCount,
      this.options.maxChallengeRounds
    );
    const maxTurns = Math.max(dynamicMaxTurns, this.options.maxTurns);

    if (this.options.verbose) {
      console.log(
        `[StreamingValidator] Session ${session.file} maxTurns: ${maxTurns} (estimated ${estimatedIssueCount} issues)`
      );
    }

    let execution: RuntimeExecution | null = null;
    let sigtermHandler: (() => void) | null = null;
    let sigintHandler: (() => void) | null = null;

    try {
      execution = runtime.execute({
        prompt: messageGenerator(),
        cwd: this.options.repoPath,
        maxTurns,
        model: runtime.config.models.validator,
        settingSources: ['project'],
      });

      let isCleaningUp = false;
      const cleanupAndExit = async (signal: string) => {
        if (isCleaningUp || !execution) return;
        isCleaningUp = true;
        console.log(
          `[StreamingValidator] Received ${signal}, cleaning up session ${session.file}...`
        );
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

      sendMessage(firstPrompt);

      let lastAssistantText = '';

      for await (const event of execution) {
        if (currentIssue) {
          let activity = '';
          if (event.type === 'assistant.text') {
            activity = `Round ${currentRound} analyzing...`;
          } else if (event.type === 'activity') {
            activity = `Round ${currentRound} reading code...`;
          }

          if (activity) {
            this.options.callbacks?.onValidationActivity?.(
              currentIssue.id,
              currentIssue.title,
              activity
            );
          }
        }

        if (event.type === 'assistant.text') {
          lastAssistantText = event.text;
          continue;
        }

        if (event.type !== 'result') {
          continue;
        }

        const inputTokens = event.usage?.inputTokens ?? 0;
        const outputTokens = event.usage?.outputTokens ?? 0;
        const turnTokens = inputTokens + outputTokens;
        session.tokensUsed += turnTokens;

        console.log(
          `[Validator-Detail] Issue="${currentIssue?.title?.slice(0, 30)}" Round=${currentRound} ` +
            `Tokens: input=${inputTokens}, output=${outputTokens}, total=${turnTokens}, ` +
            `session_total=${session.tokensUsed}`
        );

        if (event.status === 'success') {
          const responseText = event.text || lastAssistantText;
          const response = this.parseResponse(responseText);

          if (!response) {
            if (currentRound === 1) {
              completeCurrentIssue(
                this.createUncertainIssue(currentIssue!, 'Validator response could not be parsed')
              );
            } else {
              const prevResponse = currentResponses[currentResponses.length - 1]!;
              completeCurrentIssue(
                this.responseToValidatedIssue(
                  prevResponse,
                  currentIssue!,
                  'Challenge round parse failed'
                )
              );
            }
            await advanceToNextIssue();
            continue;
          }

          currentResponses.push(response);
          const maxRoundsForThisIssue = this.getMaxRoundsForIssue(currentIssue!);

          this.options.callbacks?.onRoundComplete?.(
            currentIssue!.id,
            currentIssue!.title,
            currentRound,
            maxRoundsForThisIssue,
            response.validation_status
          );

          if (this.options.verbose) {
            console.log(
              `[StreamingValidator] ${currentIssue!.id} Round ${currentRound}/${maxRoundsForThisIssue}: ${response.validation_status}`
            );
          }

          let shouldContinueChallenge = false;

          if (this.options.challengeMode && currentRound < maxRoundsForThisIssue) {
            if (currentRound >= 2) {
              const prevResponse = currentResponses[currentResponses.length - 2]!;
              if (prevResponse.validation_status !== response.validation_status) {
                shouldContinueChallenge = true;
              }
            } else {
              shouldContinueChallenge = maxRoundsForThisIssue > 1;
            }
          }

          if (shouldContinueChallenge) {
            currentRound++;

            const challengePrompt = this.buildChallengePrompt(
              currentIssue!,
              response,
              currentRound,
              currentResponses.length >= 2
                ? currentResponses[currentResponses.length - 2]
                : undefined
            );
            sendMessage(challengePrompt);
            continue;
          }

          let validatedIssue: ValidatedIssue;

          if (currentRound >= maxRoundsForThisIssue && currentResponses.length > 1) {
            validatedIssue = this.getFinalDecisionFromResponses(currentResponses, currentIssue!);
          } else {
            const note =
              currentRound >= 2
                ? 'Multi-round validation'
                : maxRoundsForThisIssue === 1
                  ? 'Single-round validation'
                  : undefined;
            validatedIssue = this.responseToValidatedIssue(response, currentIssue!, note);
          }

          const roundHistory = currentResponses
            .map((r, i) => `R${i + 1}:${r.validation_status}`)
            .join(' -> ');
          console.log(
            `[Validator-Summary] Issue="${currentIssue?.title?.slice(0, 40)}" ` +
              `Rounds=${currentRound} History=[${roundHistory}] ` +
              `Final=${validatedIssue.validation_status} SessionTokens=${session.tokensUsed}`
          );

          completeCurrentIssue(validatedIssue);
          await advanceToNextIssue();
          continue;
        }

        console.error(`[StreamingValidator] Session ${session.file} error: ${event.status}`);

        if (currentIssue) {
          if (currentResponses.length > 0) {
            completeCurrentIssue(
              this.responseToValidatedIssue(
                currentResponses[currentResponses.length - 1]!,
                currentIssue,
                'Validation interrupted'
              )
            );
          } else {
            completeCurrentIssue(this.createUncertainIssue(currentIssue, 'Validation failed'));
          }
        }

        endSession();
      }
    } catch (error) {
      console.error(`[StreamingValidator] Session ${session.file} exception:`, error);

      const issuesToRetry: RawIssue[] = [];

      if (currentIssue) {
        if (currentResponses.length > 0) {
          completeCurrentIssue(
            this.responseToValidatedIssue(
              currentResponses[currentResponses.length - 1]!,
              currentIssue,
              'Validation session crashed'
            )
          );
        } else {
          issuesToRetry.push(currentIssue);
        }
      }

      while (session.queue.length > 0) {
        issuesToRetry.push(session.queue.shift()!);
      }

      const retryCount = session.crashRetryCount ?? 0;
      if (issuesToRetry.length > 0 && retryCount < MAX_SESSION_CRASH_RETRIES) {
        console.log(
          `[StreamingValidator] Session ${session.file} crashed, attempting recovery (retry ${retryCount + 1}/${MAX_SESSION_CRASH_RETRIES})`
        );
        session.isProcessing = false;
        session.isClosed = true;
        this.startRecoverySession(session.file, issuesToRetry, retryCount + 1);
        return;
      }

      if (issuesToRetry.length > 0) {
        console.warn(
          `[StreamingValidator] Session ${session.file} max retries exceeded, marking ${issuesToRetry.length} issues as uncertain`
        );
        for (const issue of issuesToRetry) {
          const uncertainIssue = this.createUncertainIssue(
            issue,
            'Session crashed after maximum retries'
          );
          session.results.push(uncertainIssue);
          this.completedCount++;
          this.options.callbacks?.onIssueValidated?.(uncertainIssue);
          if (this.options.onProgress) {
            this.options.onProgress(
              this.completedCount,
              this.totalEnqueued,
              uncertainIssue.id,
              'uncertain'
            );
          }
        }
      }
    } finally {
      if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
      if (sigintHandler) process.off('SIGINT', sigintHandler);

      if (execution) {
        try {
          await execution.close();
        } catch (cleanupError) {
          if (this.options.verbose) {
            console.warn(
              `[StreamingValidator] Cleanup warning for session ${session.file}:`,
              cleanupError
            );
          }
        }
      }
    }

    session.isProcessing = false;
    session.isClosed = true;

    if (this.options.verbose) {
      console.log(
        `[StreamingValidator] Session ${session.file} closed: ${session.results.length} issues, ${session.tokensUsed} tokens`
      );
    }
  }

  /**
   * Start a recovery session to retry failed issues
   */
  private startRecoverySession(file: string, issues: RawIssue[], retryCount: number): void {
    // Create a new session for recovery
    const recoverySession: FileSession = {
      file,
      queue: issues,
      isProcessing: false,
      isClosed: false,
      tokensUsed: 0,
      results: [],
      crashRetryCount: retryCount,
    };

    // Replace the old session
    const oldSession = this.sessions.get(file);
    if (oldSession) {
      // Preserve results from old session
      recoverySession.results = [...oldSession.results];
      recoverySession.tokensUsed = oldSession.tokensUsed;
    }

    this.sessions.set(file, recoverySession);

    // Start processing the recovery session
    this.startSessionProcessing(recoverySession);
  }

  // ============ Helper Methods ============

  /**
   * Get maximum challenge rounds for an issue
   *
   * All issues use the same number of rounds for consistent validation quality.
   */
  private getMaxRoundsForIssue(issue: RawIssue): number {
    const policy = getHighSignalValidationPolicy(issue, this.options.maxChallengeRounds);
    return Math.max(policy.maxChallengeRounds, 1);
  }

  private buildUserPrompt(issue: RawIssue): string {
    return `请验证以下问题：

**问题 ID**: ${issue.id}
**文件**: ${issue.file}
**行号**: ${issue.line_start}-${issue.line_end}
**类型**: ${issue.category}
**严重程度**: ${issue.severity}
**标题**: ${issue.title}
**描述**: ${issue.description}
${issue.suggestion ? `**建议**: ${issue.suggestion}` : ''}
${issue.code_snippet ? `**代码片段**:\n\`\`\`\n${issue.code_snippet}\n\`\`\`` : ''}
**初始置信度**: ${issue.confidence}

请：
1. 读取实际代码文件 ${issue.file}:${issue.line_start}-${issue.line_end}
2. 检查是否存在缓解因素（错误处理、测试覆盖等）
3. 做出验证决定

以 JSON 格式返回验证结果。`;
  }

  private buildChallengePrompt(
    _issue: RawIssue,
    prevResponse: ParsedValidationResponse,
    round: number,
    prevPrevResponse?: ParsedValidationResponse
  ): string {
    const prevStatus = prevResponse.validation_status;

    // Fast mode: round 2 is the final confirmation
    if (this.options.fastMode && round === 2) {
      return `你刚才经过自我质疑后判断这个问题为 "${prevStatus}"。

这是最终确认轮：请再次审视你的分析，确认你没有遗漏关键因素。如果你的判断有变，请说明原因。

以相同的 JSON 格式给出你的最终判断。`;
    }

    // Normal mode: progressive challenge rounds
    if (round === 2) {
      return `你刚才判断这个问题为 "${prevStatus}"。

我需要你再次确认：**你确定吗？**

请重新审视代码和你的分析，确保没有遗漏任何重要因素。以相同的 JSON 格式给出你的最终判断。`;
    }

    if (round === 3) {
      return `你的判断从 "${prevPrevResponse?.validation_status}" 变成了 "${prevStatus}"。

请提供**更具体的代码证据**来支持你的判断。指出具体的代码行和逻辑。以 JSON 格式回复。`;
    }

    if (round === 4) {
      return `现在请考虑**反面论点**：

如果你判断为 "${prevStatus}"，请思考为什么有人可能会得出相反的结论。考虑这些反面论点后，你的最终判断是什么？

以 JSON 格式回复。`;
    }

    // Round 5
    return `这是**最后一轮**。

综合之前所有的分析和考量，请给出你的最终判断。不要犹豫，明确回答 confirmed、rejected 或 uncertain。

以 JSON 格式回复。`;
  }

  private parseResponse(text: string): ParsedValidationResponse | null {
    try {
      const json = extractJSON(text);
      if (!json) return null;

      const parsed = JSON.parse(json);

      // Validate required fields
      if (
        !parsed.validation_status ||
        !['confirmed', 'rejected', 'uncertain'].includes(parsed.validation_status)
      ) {
        return null;
      }

      // Parse checked_symbols - convert strings to SymbolLookup objects
      const rawSymbols = parsed.grounding_evidence?.checked_symbols ?? [];
      const checkedSymbols: SymbolLookup[] = rawSymbols.map((s: string | SymbolLookup) => {
        if (typeof s === 'string') {
          return { name: s, type: 'reference' as const, locations: [] };
        }
        return s;
      });

      // Validate revised_severity if present
      const validSeverities = ['critical', 'error', 'warning', 'suggestion'];
      const revisedSeverity =
        parsed.revised_severity && validSeverities.includes(parsed.revised_severity)
          ? (parsed.revised_severity as 'critical' | 'error' | 'warning' | 'suggestion')
          : undefined;

      return {
        validation_status: parsed.validation_status,
        final_confidence: parsed.final_confidence ?? 0.5,
        grounding_evidence: {
          checked_files: parsed.grounding_evidence?.checked_files ?? [],
          checked_symbols: checkedSymbols,
          related_context: parsed.grounding_evidence?.related_context ?? '',
          reasoning: parsed.grounding_evidence?.reasoning ?? parsed.reasoning ?? '',
        },
        rejection_reason: parsed.rejection_reason,
        revised_description: parsed.revised_description,
        revised_severity: revisedSeverity,
      };
    } catch {
      return null;
    }
  }

  private responseToValidatedIssue(
    response: ParsedValidationResponse,
    issue: RawIssue,
    _note?: string
  ): ValidatedIssue {
    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category,
      severity: response.revised_severity ?? issue.severity,
      title: issue.title,
      description: response.revised_description ?? issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence,
      source_agent: issue.source_agent,
      validation_status: response.validation_status,
      grounding_evidence: response.grounding_evidence,
      final_confidence: response.final_confidence,
      rejection_reason: response.rejection_reason,
    };
  }

  private createUncertainIssue(issue: RawIssue, reason: string): ValidatedIssue {
    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category,
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence,
      source_agent: issue.source_agent,
      validation_status: 'uncertain',
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: reason,
        reasoning: reason,
      },
      final_confidence: issue.confidence * 0.5,
    };
  }

  private createAutoRejectedIssue(issue: RawIssue, reason?: string): ValidatedIssue {
    void reason;
    const resolvedReason = reason || '置信度过低，自动拒绝';
    void resolvedReason;
    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category,
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence,
      source_agent: issue.source_agent,
      validation_status: 'rejected',
      grounding_evidence: {
        checked_files: [],
        checked_symbols: [],
        related_context: '置信度过低，自动跳过验证',
        reasoning: `置信度 ${issue.confidence} 低于阈值 ${MIN_CONFIDENCE_FOR_VALIDATION}，自动拒绝`,
      },
      final_confidence: issue.confidence,
      rejection_reason: `置信度过低 (${issue.confidence} < ${MIN_CONFIDENCE_FOR_VALIDATION})`,
    };
  }

  private getFinalDecisionFromResponses(
    responses: ParsedValidationResponse[],
    issue: RawIssue
  ): ValidatedIssue {
    // Count votes
    const votes = { confirmed: 0, rejected: 0, uncertain: 0 };
    for (const r of responses) {
      votes[r.validation_status]++;
    }

    // Find majority
    let finalStatus: 'confirmed' | 'rejected' | 'uncertain' = 'uncertain';
    let maxVotes = 0;

    for (const [status, count] of Object.entries(votes)) {
      if (count > maxVotes) {
        maxVotes = count;
        finalStatus = status as 'confirmed' | 'rejected' | 'uncertain';
      }
    }

    // Tie-breaking: when no clear majority, use the last response's status
    // This is important for fast mode (2 rounds) where R2 is the final confirmation
    const hasClearMajority = maxVotes * 2 > responses.length;
    if (!hasClearMajority) {
      finalStatus = responses[responses.length - 1]!.validation_status;
    }

    // Use last response's details
    const lastResponse = responses[responses.length - 1]!;

    return {
      id: issue.id,
      file: issue.file,
      line_start: issue.line_start,
      line_end: issue.line_end,
      category: issue.category,
      severity: lastResponse.revised_severity ?? issue.severity,
      title: issue.title,
      description: lastResponse.revised_description ?? issue.description,
      suggestion: issue.suggestion,
      code_snippet: issue.code_snippet,
      confidence: issue.confidence,
      source_agent: issue.source_agent,
      validation_status: finalStatus,
      grounding_evidence: {
        ...lastResponse.grounding_evidence,
        reasoning: `多轮投票结果: confirmed=${votes.confirmed}, rejected=${votes.rejected}, uncertain=${votes.uncertain}. ${lastResponse.grounding_evidence.reasoning}`,
      },
      final_confidence:
        finalStatus === 'uncertain'
          ? 0.5
          : responses
              .filter((r) => r.validation_status === finalStatus)
              .reduce((sum, r) => sum + r.final_confidence, 0) / maxVotes,
      rejection_reason: finalStatus === 'rejected' ? lastResponse.rejection_reason : undefined,
    };
  }
}

/**
 * Create a streaming validator instance
 */
export function createStreamingValidator(options: StreamingValidatorOptions): StreamingValidator {
  return new StreamingValidator(options);
}
