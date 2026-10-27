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
import { createRepoContextTools } from '../runtime/repo-context-tools.js';
import type { FrontendDependencyContext } from './dependency-context/types.js';
import { formatFrontendDependencyContext } from './dependency-context/extractor.js';
import { calculateRetryDelayMs, getRetryAfterMs, waitForRetry } from './retry-policy.js';

/** Maximum number of times to retry a crashed session */
const MAX_SESSION_CRASH_RETRIES = 2;
const OPENAI_VALIDATION_READ_CONTEXT_LINES = 60;
const OPENAI_VALIDATION_DEFAULT_READ_LIMIT = 140;
const OPENAI_VALIDATION_MAX_READ_LIMIT = 180;
const MAX_VALIDATION_DESCRIPTION_CHARS = 5000;
const MAX_VALIDATION_SUGGESTION_CHARS = 3000;
const MAX_VALIDATION_CODE_SNIPPET_CHARS = 6000;
const MAX_CHALLENGE_ROUNDS_FOR_LARGE_CONTEXT = 2;
const LARGE_ISSUE_CONTEXT_CHARS = 12000;

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }

  if (error && typeof error === 'object') {
    const name = 'name' in error ? error.name : undefined;
    const code = 'code' in error ? error.code : undefined;
    if (name === 'AbortError' || name === 'CanceledError' || code === 'ABORT_ERR') {
      return true;
    }
  }

  return /^(?:(?:the|this) )?(?:user|request|operation|review|validation|execution|stream) (?:was |is )?(?:aborted|cancelled|canceled)\b/i.test(
    getFailureReason(error)
  );
}

function getFailureReason(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : undefined;
    const details = [
      record.message,
      record.code,
      record.status,
      nested?.message,
      nested?.type,
    ].filter((value) => typeof value === 'string' || typeof value === 'number');
    if (details.length > 0) return details.join(': ');
  }
  return String(error);
}

function truncatePromptText(value: string | undefined, maxChars: number): string | undefined {
  if (!value || value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars for validator context budget]`;
}

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
  /** Max lines the validator Read tool returns per call (default: 140, cap 180) */
  readLimit?: number;
  /** Use fast mode validation prompt (self-challenge in single round) */
  fastMode?: boolean;
  /** Output language for review comments */
  language?: 'en' | 'zh';
  /** Abort controller shared with the enclosing review. */
  abortController?: AbortController;
  /** Frontend dependency grounding for version-sensitive validation */
  dependencyContext?: FrontendDependencyContext;
}

/**
 * Resolved options with defaults
 */
interface ResolvedOptions {
  repoPath: string;
  verbose: boolean;
  maxTurns?: number;
  onProgress?: StreamingValidationProgressCallback;
  callbacks?: StreamingValidationCallbacks;
  challengeMode: boolean;
  maxConcurrentSessions: number;
  sessionIdleTimeoutMs: number;
  projectRules?: string;
  maxChallengeRounds: number;
  readLimit?: number;
  fastMode: boolean;
  language: 'en' | 'zh';
  abortController?: AbortController;
  dependencyContext?: FrontendDependencyContext;
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
  /** Input tokens used by this session */
  inputTokensUsed: number;
  /** Cached input tokens used by this session */
  cachedInputTokensUsed: number;
  /** Output tokens used by this session */
  outputTokensUsed: number;
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
  /** Issues that arrived after this session failed and must wait for cleanup/recovery */
  deferredIssues?: RawIssue[];
  /** Abortable controller used by runtime execution and recovery waits. */
  abortController?: AbortController;
  /** Idempotent cleanup for the currently active execution. */
  closeExecution?: () => Promise<void>;
  /** Preserve pending issue accounting when cancellation interrupts a hanging stream. */
  cancelPending?: (reason: string) => void;
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
  private incompleteReasons: string[] = [];
  private warnedReadLimit = false;
  private stopReason?: string;
  private reportedRounds = new Map<string, Map<number, ValidationStatus>>();

  private recordIncomplete(reason: string): void {
    if (!this.incompleteReasons.includes(reason)) {
      this.incompleteReasons.push(reason);
    }
  }

  constructor(options: StreamingValidatorOptions) {
    const fastMode = options.fastMode ?? false;
    this.options = {
      verbose: options.verbose ?? false,
      maxTurns: options.maxTurns,
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
      readLimit: options.readLimit,
      fastMode,
      language: options.language ?? 'zh',
      abortController: options.abortController,
      dependencyContext: options.dependencyContext,
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
    const file = typeof issue.file === 'string' ? issue.file.trim() : '';
    const normalizedIssue = file === issue.file ? issue : { ...issue, file };

    // Notify issue discovered
    this.options.callbacks?.onIssueDiscovered?.(normalizedIssue);

    if (!file) {
      const reason = `Issue "${issue.title}" has a missing file path and could not be validated`;
      const uncertainIssue = this.createUncertainIssue(normalizedIssue, reason);
      this.totalEnqueued++;
      this.completedCount++;
      this.recordIncomplete(reason);
      this.options.callbacks?.onIssueValidated?.(uncertainIssue);
      this.options.onProgress?.(
        this.completedCount,
        this.totalEnqueued,
        uncertainIssue.id,
        'uncertain'
      );
      return uncertainIssue;
    }

    const validationPolicy = getHighSignalValidationPolicy(
      normalizedIssue,
      this.options.maxChallengeRounds
    );
    const shouldRejectByConfidence =
      normalizedIssue.severity !== 'critical' &&
      normalizedIssue.confidence < validationPolicy.minConfidence;

    if (!validationPolicy.shouldValidate || shouldRejectByConfidence) {
      const rejectionReason =
        validationPolicy.rejectionReason ||
        `置信度过低 (${normalizedIssue.confidence} < ${validationPolicy.minConfidence})`;
      const rejected = this.createAutoRejectedIssue(normalizedIssue, rejectionReason);
      rejected.grounding_evidence.related_context = rejectionReason;
      rejected.grounding_evidence.reasoning = rejectionReason;
      rejected.rejection_reason = rejectionReason;
      this.completedCount++;
      this.totalEnqueued++;

      // Notify via callbacks
      this.options.callbacks?.onAutoRejected?.(normalizedIssue, rejectionReason);

      if (this.options.onProgress) {
        this.options.onProgress(
          this.completedCount,
          this.totalEnqueued,
          normalizedIssue.id,
          'rejected'
        );
      }

      if (this.options.verbose) {
        console.log(`[StreamingValidator] Auto-rejected ${normalizedIssue.id}: ${rejectionReason}`);
      }

      return rejected;
    }

    this.totalEnqueued++;

    const cancellationReason = this.getStopReason();
    if (cancellationReason) {
      const session = this.sessions.get(file) ?? this.getOrCreateSession(file);
      this.completeIssue(session, this.createUncertainIssue(normalizedIssue, cancellationReason));
      this.recordIncomplete(cancellationReason);
      return null;
    }

    const currentSession = this.sessions.get(file);
    if (currentSession?.isClosed && currentSession.isProcessing) {
      currentSession.deferredIssues ??= [];
      currentSession.deferredIssues.push(normalizedIssue);
      if (this.options.verbose) {
        console.log(
          `[StreamingValidator] Deferred ${normalizedIssue.id} until the failed session for ${file} closes`
        );
      }
      return null;
    }

    // Get or create session for this file
    const session = this.getOrCreateSession(file);

    // Add to queue
    session.queue.push(normalizedIssue);

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
  async flush(timeoutMs: number = 1800000): Promise<{
    issues: ValidatedIssue[];
    tokensUsed: number;
    inputTokensUsed: number;
    cachedInputTokensUsed: number;
    outputTokensUsed: number;
    incompleteReasons: string[];
  }> {
    this.markAgentsComplete();

    const startTime = Date.now();

    // Recovery cleanup and backoff remain part of the processing promise.
    while (true) {
      const activeSessions = Array.from(this.sessions.values()).filter(
        (session) => session.processingPromise && session.isProcessing
      );
      if (activeSessions.length === 0) break;

      const remainingTimeout = timeoutMs - (Date.now() - startTime);
      if (remainingTimeout <= 0) {
        const reason = 'Validation flush timed out; partial validation results were used';
        this.recordIncomplete(reason);
        this.stopValidation(reason);
        break;
      }

      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      const outcome = await Promise.race([
        Promise.all(activeSessions.map((session) => session.processingPromise)).then(
          () => 'complete' as const
        ),
        new Promise<'timeout'>((resolve) => {
          timer = globalThis.setTimeout(() => resolve('timeout'), remainingTimeout);
        }),
      ]);
      if (timer) globalThis.clearTimeout(timer);
      if (outcome === 'timeout') {
        const reason = 'Validation flush timed out; partial validation results were used';
        this.recordIncomplete(reason);
        this.stopValidation(reason);
        break;
      }
    }

    // Collect all results (including partial if timed out)
    const allIssues: ValidatedIssue[] = [];
    let totalTokens = 0;
    let totalInputTokens = 0;
    let totalCachedInputTokens = 0;
    let totalOutputTokens = 0;

    for (const session of this.sessions.values()) {
      allIssues.push(...session.results);
      totalTokens += session.tokensUsed;
      totalInputTokens += session.inputTokensUsed;
      totalCachedInputTokens += session.cachedInputTokensUsed;
      totalOutputTokens += session.outputTokensUsed;
    }

    if (this.options.verbose) {
      console.log(
        `[StreamingValidator] Flush complete: ${allIssues.length} issues, ${totalTokens} tokens`
      );
    }

    return {
      issues: allIssues,
      incompleteReasons: [...this.incompleteReasons],
      inputTokensUsed: totalInputTokens,
      cachedInputTokensUsed: totalCachedInputTokens,
      outputTokensUsed: totalOutputTokens,
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

  private getStopReason(): string | undefined {
    if (this.stopReason) return this.stopReason;
    if (this.options.abortController?.signal.aborted) {
      return `Validation cancelled: ${getFailureReason(this.options.abortController.signal.reason)}`;
    }
    return undefined;
  }

  private stopValidation(reason: string): void {
    this.stopReason ??= reason;
    for (const session of this.sessions.values()) {
      session.cancelPending?.(reason);
      session.abortController?.abort(new Error(reason));
      session.notifyNewIssue?.();
      void session.closeExecution?.();
    }
  }

  private completeIssue(session: FileSession, issue: ValidatedIssue): void {
    if (session.results.some((result) => result.id === issue.id)) return;
    session.results.push(issue);
    this.completedCount++;
    this.options.callbacks?.onIssueValidated?.(issue);
    this.options.onProgress?.(
      this.completedCount,
      this.totalEnqueued,
      issue.id,
      issue.validation_status
    );
  }

  private reportRound(issue: RawIssue, round: number, status: ValidationStatus): void {
    const reported = this.reportedRounds.get(issue.id) ?? new Map<number, ValidationStatus>();
    // Recovery can replay a completed round with a different verdict. Notify that
    // change while suppressing identical replayed progress events.
    if (reported.get(round) === status) return;
    reported.set(round, status);
    this.reportedRounds.set(issue.id, reported);
    this.options.callbacks?.onRoundComplete?.(
      issue.id,
      issue.title,
      round,
      this.getMaxRoundsForIssue(issue),
      status
    );
  }

  private getOrCreateSession(file: string): FileSession {
    let session = this.sessions.get(file);
    if (!session || session.isClosed) {
      const previousSession = session;
      session = {
        file,
        queue: previousSession ? [...previousSession.queue] : [],
        isProcessing: false,
        isClosed: false,
        tokensUsed: previousSession?.tokensUsed ?? 0,
        inputTokensUsed: previousSession?.inputTokensUsed ?? 0,
        cachedInputTokensUsed: previousSession?.cachedInputTokensUsed ?? 0,
        outputTokensUsed: previousSession?.outputTokensUsed ?? 0,
        results: previousSession ? [...previousSession.results] : [],
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

    const abortController = new AbortController();
    session.abortController = abortController;
    const parentSignal = this.options.abortController?.signal;
    const onAbort = () => {
      this.stopReason ??= `Validation cancelled: ${getFailureReason(parentSignal?.reason)}`;
      session.cancelPending?.(this.stopReason);
      abortController.abort(parentSignal?.reason);
      session.notifyNewIssue?.();
      void session.closeExecution?.();
    };
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    if (parentSignal?.aborted) onAbort();

    const throwIfStopped = () => {
      const reason = this.getStopReason();
      if (reason || abortController.signal.aborted) {
        throw Object.assign(new Error(reason ?? 'Validation cancelled'), { name: 'AbortError' });
      }
    };

    let runtime: ReturnType<typeof createRuntimeFromEnv>;
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

        if (this.allAgentsComplete || this.getStopReason()) {
          resolve(false);
          return;
        }

        session.notifyNewIssue = () => {
          if (session.queue.length === 0 && !this.allAgentsComplete && !this.getStopReason()) {
            return;
          }
          session.notifyNewIssue = undefined;
          if (session.idleTimeout) {
            globalThis.clearTimeout(session.idleTimeout);
            session.idleTimeout = undefined;
          }
          resolve(session.queue.length > 0 && !this.getStopReason());
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
      throwIfStopped();
      if (session.queue.length > 0) {
        return session.queue.shift()!;
      }

      const hasMore = await waitForNewIssue();
      throwIfStopped();
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
      const dependencyContextText = this.options.dependencyContext
        ? formatFrontendDependencyContext(this.options.dependencyContext, issue.file)
        : '';
      const dependencyRules = dependencyContextText
        ? `${dependencyContextText}\n\nGrounding rule:\n- Reject version-sensitive suggestions that exceed these grounded versions.\n- If the suggested API requires a newer package version, reject it unless the issue explicitly calls out the upgrade requirement.\n- Treat compatibility notes as authoritative. Reject issues that rely on older framework conventions contradicted by these grounded versions.\n\n`
        : '';
      const userPrompt = `${dependencyRules}${this.buildUserPrompt(issue)}`;

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
      this.completeIssue(session, validatedIssue);
      currentIssue = null;
      currentRound = 0;
      currentResponses = [];
    };

    session.cancelPending = (reason: string) => {
      const issues = currentIssue
        ? [currentIssue, ...session.queue.splice(0)]
        : session.queue.splice(0);
      issues.push(...(session.deferredIssues?.splice(0) ?? []));
      if (issues.length > 0) this.recordIncomplete(reason);
      currentIssue = null;
      for (const issue of issues) {
        this.completeIssue(session, this.createUncertainIssue(issue, reason));
      }
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

    let execution: RuntimeExecution | null = null;
    let closingExecution: Promise<void> | undefined;
    const closeExecution = async () => {
      if (!execution) return;
      const activeExecution = execution;
      closingExecution ??= Promise.resolve()
        .then(() => activeExecution.close())
        .catch((cleanupError: unknown) => {
          if (this.options.verbose) {
            console.warn(`[StreamingValidator] Cleanup warning for ${session.file}:`, cleanupError);
          }
        });
      await closingExecution;
      execution = null;
      closingExecution = undefined;
    };
    session.closeExecution = closeExecution;
    let sigtermHandler: (() => void) | null = null;
    let sigintHandler: (() => void) | null = null;
    const runOpenAIWithFreshExecutions = async () => {
      // Reuse within a single issue for challenge rounds, but reset between issues.
      // OpenAI validator sessions can accumulate enough prior turns and tool output
      // to trip context_length_exceeded on later same-file issues.
      while (true) {
        currentIssue = await getNextIssue();
        if (!currentIssue) {
          return;
        }

        currentRound = 1;
        currentResponses = [];
        const configuredReadLimit = this.options.readLimit;
        const repoContextTools = createRepoContextTools(this.options.repoPath, {
          defaultReadLimit: configuredReadLimit ?? OPENAI_VALIDATION_DEFAULT_READ_LIMIT,
          maxReadLimit: configuredReadLimit ?? OPENAI_VALIDATION_MAX_READ_LIMIT,
          focusedReadWindow: {
            filePath: currentIssue.file,
            lineStart: currentIssue.line_start,
            lineEnd: currentIssue.line_end,
            contextLines: OPENAI_VALIDATION_READ_CONTEXT_LINES,
          },
        });

        const toPromptMessage = (content: string): RuntimePromptMessage => ({
          type: 'user',
          message: {
            role: 'user',
            content,
          },
          parent_tool_use_id: null,
          session_id: '',
        });

        const promptQueue: Array<RuntimePromptMessage | null> = [
          toPromptMessage(buildIssuePrompt(currentIssue, true)),
        ];
        let resolveNextPrompt: ((prompt: RuntimePromptMessage | null) => void) | null = null;

        async function* promptGenerator(): AsyncGenerator<RuntimePromptMessage> {
          while (true) {
            const prompt = await new Promise<RuntimePromptMessage | null>((resolve) => {
              if (promptQueue.length > 0) {
                resolve(promptQueue.shift() ?? null);
              } else {
                resolveNextPrompt = resolve;
              }
            });

            if (prompt === null) {
              return;
            }

            yield prompt;
          }
        }

        const sendPrompt = (content: string) => {
          if (resolveNextPrompt) {
            const resolve = resolveNextPrompt;
            resolveNextPrompt = null;
            resolve(toPromptMessage(content));
          } else {
            promptQueue.push(toPromptMessage(content));
          }
        };

        const endPromptStream = () => {
          if (resolveNextPrompt) {
            const resolve = resolveNextPrompt;
            resolveNextPrompt = null;
            resolve(null);
          } else {
            promptQueue.push(null);
          }
        };

        const maxTurns =
          this.options.maxTurns ??
          Math.max(
            getValidatorMaxTurns(1, this.options.maxChallengeRounds),
            DEFAULT_VALIDATOR_MAX_TURNS
          );
        let lastAssistantText = '';
        let finalizedIssue: ValidatedIssue | null = null;

        throwIfStopped();
        execution = runtime.execute({
          prompt: promptGenerator(),
          cwd: this.options.repoPath,
          maxTurns,
          model: runtime.config.models.validator,
          // 验证阶段默认降档推理（主流程高于 medium 时；可被 env 覆盖）。
          ...(runtime.config.validatorReasoningEffort
            ? { reasoningEffort: runtime.config.validatorReasoningEffort }
            : {}),
          settingSources: ['project'],
          abortController,
          tools: repoContextTools,
        });

        try {
          try {
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
                throwIfStopped();
                continue;
              }

              const inputTokens = event.usage?.inputTokens ?? 0;
              const cachedInputTokens = event.usage?.cachedInputTokens ?? 0;
              const outputTokens = event.usage?.outputTokens ?? 0;
              const turnTokens = inputTokens + outputTokens;
              session.inputTokensUsed += inputTokens;
              session.cachedInputTokensUsed += cachedInputTokens;
              session.outputTokensUsed += outputTokens;
              session.tokensUsed += turnTokens;

              console.log(
                `[Validator-Detail] Issue="${currentIssue?.title?.slice(0, 30)}" Round=${currentRound} ` +
                  `Tokens: input=${inputTokens}, output=${outputTokens}, total=${turnTokens}, ` +
                  `session_total=${session.tokensUsed}`
              );

              throwIfStopped();
              if (event.status === 'success') {
                const responseText = event.text || lastAssistantText;
                const response = this.parseResponse(responseText);

                if (!response) {
                  throw new Error(
                    `Validator response could not be parsed in round ${currentRound}`
                  );
                }

                currentResponses.push(response);
                const maxRoundsForThisIssue = this.getMaxRoundsForIssue(currentIssue!);

                this.reportRound(currentIssue!, currentRound, response.validation_status);

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
                  sendPrompt(
                    this.buildChallengePrompt(
                      currentIssue!,
                      response,
                      currentRound,
                      currentResponses.length >= 2
                        ? currentResponses[currentResponses.length - 2]
                        : undefined
                    )
                  );
                  continue;
                }

                finalizedIssue =
                  currentRound >= maxRoundsForThisIssue && currentResponses.length > 1
                    ? this.getFinalDecisionFromResponses(currentResponses, currentIssue!)
                    : this.responseToValidatedIssue(
                        response,
                        currentIssue!,
                        currentRound >= 2 ? 'Multi-round validation' : 'Single-round validation'
                      );

                const roundHistory = currentResponses
                  .map((roundResponse, index) => `R${index + 1}:${roundResponse.validation_status}`)
                  .join(' -> ');
                console.log(
                  `[Validator-Summary] Issue="${currentIssue?.title?.slice(0, 40)}" ` +
                    `Rounds=${currentRound} History=[${roundHistory}] ` +
                    `Final=${finalizedIssue.validation_status} SessionTokens=${session.tokensUsed}`
                );

                endPromptStream();
                continue;
              }

              console.error(`[StreamingValidator] Session ${session.file} error: ${event.status}`);

              const interruptedIssueLabel = currentIssue
                ? `"${currentIssue.title}" (${currentIssue.file}:${currentIssue.line_start})`
                : `session ${session.file}`;
              const reason = [
                event.status === 'error_max_turns'
                  ? `Validation turn budget exhausted (${maxTurns} turns)`
                  : `runtime returned ${event.status}`,
                event.rawStopReason,
                event.error,
              ]
                .filter(Boolean)
                .join(': ');
              session.isClosed = true;
              const error = new Error(`Validation failed for ${interruptedIssueLabel}: ${reason}`);
              if (
                /^(?:error_)?(?:aborted|cancelled|canceled)$/i.test(event.status) ||
                /^(?:aborted|cancelled|canceled)$/i.test(event.rawStopReason ?? '') ||
                isCancellationError(event.error)
              )
                error.name = 'AbortError';
              throw error;
            }
            if (!finalizedIssue) {
              throw new Error(
                `Validator runtime ended without a terminal result for round ${currentRound}`
              );
            }
          } catch (error) {
            session.isClosed = true;
            throw error;
          }
        } finally {
          endPromptStream();
          await closeExecution();
        }

        throwIfStopped();
        completeCurrentIssue(finalizedIssue!);
      }
    };

    let failure: { error: unknown; reason: string; cancelled: boolean } | undefined;
    try {
      throwIfStopped();
      runtime = createRuntimeFromEnv();
      if (runtime.kind !== 'openai-responses') {
        currentIssue = await getNextIssue();
        if (!currentIssue) {
          session.isProcessing = false;
          session.isClosed = true;
          return;
        }
      }

      const firstPrompt = currentIssue ? buildIssuePrompt(currentIssue, true) : '';
      currentRound = currentIssue ? 1 : 0;

      const estimatedIssueCount =
        runtime.kind === 'openai-responses' ? 1 : Math.max(session.queue.length + 1, 5);
      const dynamicMaxTurns = getValidatorMaxTurns(
        estimatedIssueCount,
        this.options.maxChallengeRounds
      );
      const maxTurns =
        this.options.maxTurns ?? Math.max(dynamicMaxTurns, DEFAULT_VALIDATOR_MAX_TURNS);

      if (this.options.verbose) {
        console.log(
          `[StreamingValidator] Session ${session.file} maxTurns: ${maxTurns} (estimated ${estimatedIssueCount} issues)`
        );
      }

      let isCleaningUp = false;
      const cleanupAndExit = async (signal: string) => {
        if (isCleaningUp || !execution) return;
        isCleaningUp = true;
        console.log(
          `[StreamingValidator] Received ${signal}, cleaning up session ${session.file}...`
        );
        try {
          await closeExecution();
        } catch {
          // Ignore shutdown cleanup errors.
        }
        process.exit(0);
      };
      sigtermHandler = () => cleanupAndExit('SIGTERM');
      sigintHandler = () => cleanupAndExit('SIGINT');
      process.on('SIGTERM', sigtermHandler);
      process.on('SIGINT', sigintHandler);

      if (this.options.readLimit && runtime.kind !== 'openai-responses' && !this.warnedReadLimit) {
        this.warnedReadLimit = true;
        console.warn(
          `[StreamingValidator] --validation-read-limit applies to the openai-responses runtime only; ignoring it under ${runtime.kind}`
        );
      }

      if (runtime.kind === 'openai-responses') {
        await runOpenAIWithFreshExecutions();
      } else {
        const repoContextTools: ReturnType<typeof createRepoContextTools> = [];

        throwIfStopped();
        execution = runtime.execute({
          prompt: messageGenerator(),
          cwd: this.options.repoPath,
          maxTurns,
          model: runtime.config.models.validator,
          ...(runtime.config.validatorReasoningEffort
            ? { reasoningEffort: runtime.config.validatorReasoningEffort }
            : {}),
          settingSources: ['project'],
          abortController,
          ...(repoContextTools.length > 0 ? { tools: repoContextTools } : {}),
        });

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
          const cachedInputTokens = event.usage?.cachedInputTokens ?? 0;
          const outputTokens = event.usage?.outputTokens ?? 0;
          const turnTokens = inputTokens + outputTokens;
          session.inputTokensUsed += inputTokens;
          session.cachedInputTokensUsed += cachedInputTokens;
          session.outputTokensUsed += outputTokens;
          session.tokensUsed += turnTokens;

          console.log(
            `[Validator-Detail] Issue="${currentIssue?.title?.slice(0, 30)}" Round=${currentRound} ` +
              `Tokens: input=${inputTokens}, output=${outputTokens}, total=${turnTokens}, ` +
              `session_total=${session.tokensUsed}`
          );

          throwIfStopped();
          if (event.status === 'success') {
            const responseText = event.text || lastAssistantText;
            const response = this.parseResponse(responseText);

            if (!response) {
              throw new Error(`Validator response could not be parsed in round ${currentRound}`);
            }

            currentResponses.push(response);
            const maxRoundsForThisIssue = this.getMaxRoundsForIssue(currentIssue!);

            this.reportRound(currentIssue!, currentRound, response.validation_status);

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

          const interruptedIssueLabel = currentIssue
            ? `"${currentIssue.title}" (${currentIssue.file}:${currentIssue.line_start})`
            : `session ${session.file}`;
          session.isClosed = true;
          const error = new Error(
            `Validation ended with status "${event.status}"${event.rawStopReason ? ` (${event.rawStopReason})` : ''}: ${interruptedIssueLabel}: ${event.status === 'error_max_turns' ? `Validation turn budget exhausted (${maxTurns} turns)` : (event.error ?? 'incomplete provider response')}`
          );
          if (
            /^(?:error_)?(?:aborted|cancelled|canceled)$/i.test(event.status) ||
            /^(?:aborted|cancelled|canceled)$/i.test(event.rawStopReason ?? '') ||
            isCancellationError(event.error)
          )
            error.name = 'AbortError';
          throw error;
        }
        throwIfStopped();
        if (currentIssue || session.queue.length > 0) {
          throw new Error(
            `Validator runtime ended without a terminal result for round ${currentRound}`
          );
        }
      }
    } catch (error) {
      session.isClosed = true;
      failure = {
        error,
        reason: getFailureReason(error),
        cancelled: isCancellationError(error, abortController.signal),
      };
      if (failure.cancelled) {
        this.stopValidation(`Validation cancelled: ${failure.reason}`);
      }
    } finally {
      if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
      if (sigintHandler) process.off('SIGINT', sigintHandler);
      if (session.idleTimeout) {
        globalThis.clearTimeout(session.idleTimeout);
        session.idleTimeout = undefined;
      }
      await closeExecution();
    }

    // Keep this processing promise active while cleanup and backoff finish.
    // New issues remain deferred on this session and cannot reset its retry count.
    if (failure && !failure.cancelled && !this.getStopReason()) {
      const retryCount = session.crashRetryCount ?? 0;
      if ((currentIssue || session.queue.length > 0) && retryCount < MAX_SESSION_CRASH_RETRIES) {
        const delayMs = calculateRetryDelayMs(retryCount + 1, {
          retryAfterMs: getRetryAfterMs(failure.error),
        });
        console.warn(
          `[StreamingValidator] Session ${session.file} recovery ${retryCount + 1}/${MAX_SESSION_CRASH_RETRIES} in ${delayMs}ms: ${failure.reason}`
        );
        const canRetry = await waitForRetry(delayMs, abortController.signal);
        if (canRetry && !this.getStopReason()) {
          const issues = currentIssue
            ? [currentIssue, ...session.queue.splice(0)]
            : session.queue.splice(0);
          parentSignal?.removeEventListener('abort', onAbort);
          session.closeExecution = undefined;
          session.cancelPending = undefined;
          this.startRecoverySession(session, issues, retryCount + 1);
          session.isProcessing = false;
          return;
        }
      }
    }

    const pending = currentIssue
      ? [currentIssue, ...session.queue.splice(0)]
      : session.queue.splice(0);
    const deferred = session.deferredIssues?.splice(0) ?? [];
    const stopReason = this.getStopReason();
    if (failure || stopReason) {
      const reason =
        stopReason ??
        `Validation session crashed after maximum retries (${MAX_SESSION_CRASH_RETRIES} retries): ${failure!.reason}`;
      if (failure || pending.length > 0 || (stopReason && deferred.length > 0)) {
        const issueLabels = pending
          .map((issue) => `"${issue.title}" (${issue.file}:${issue.line_start})`)
          .join(', ');
        this.recordIncomplete(`${reason}${issueLabels ? `: ${issueLabels}` : ''}`);
      }
      for (const issue of [...pending, ...(stopReason ? deferred : [])]) {
        this.completeIssue(session, this.createUncertainIssue(issue, reason));
      }
    }

    parentSignal?.removeEventListener('abort', onAbort);
    session.closeExecution = undefined;
    session.cancelPending = undefined;
    session.isProcessing = false;
    session.isClosed = true;
    if (!stopReason && deferred.length > 0) {
      const nextSession = this.getOrCreateSession(session.file);
      nextSession.queue.push(...deferred);
      this.startSessionProcessing(nextSession);
    }
  }

  private startRecoverySession(
    previous: FileSession,
    issues: RawIssue[],
    retryCount: number
  ): void {
    const recoverySession: FileSession = {
      file: previous.file,
      queue: issues,
      isProcessing: false,
      isClosed: false,
      tokensUsed: previous.tokensUsed,
      inputTokensUsed: previous.inputTokensUsed,
      cachedInputTokensUsed: previous.cachedInputTokensUsed,
      outputTokensUsed: previous.outputTokensUsed,
      results: [...previous.results],
      crashRetryCount: retryCount,
      deferredIssues: previous.deferredIssues,
    };
    previous.deferredIssues = undefined;
    this.sessions.set(previous.file, recoverySession);
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
    const issueContextChars = [
      issue.title,
      issue.description,
      issue.suggestion ?? '',
      issue.code_snippet ?? '',
    ].join('\n').length;
    const maxChallengeRounds =
      issueContextChars > LARGE_ISSUE_CONTEXT_CHARS
        ? Math.min(policy.maxChallengeRounds, MAX_CHALLENGE_ROUNDS_FOR_LARGE_CONTEXT)
        : policy.maxChallengeRounds;

    return Math.max(maxChallengeRounds, 1);
  }

  private buildUserPrompt(issue: RawIssue): string {
    const description =
      truncatePromptText(issue.description, MAX_VALIDATION_DESCRIPTION_CHARS) ?? issue.description;
    const suggestion = truncatePromptText(issue.suggestion, MAX_VALIDATION_SUGGESTION_CHARS);
    const codeSnippet = truncatePromptText(issue.code_snippet, MAX_VALIDATION_CODE_SNIPPET_CHARS);

    return `请验证以下问题：

**问题 ID**: ${issue.id}
**文件**: ${issue.file}
**行号**: ${issue.line_start}-${issue.line_end}
**类型**: ${issue.category}
**严重程度**: ${issue.severity}
**标题**: ${issue.title}
**描述**: ${description}
${suggestion ? `**建议**: ${suggestion}` : ''}
${codeSnippet ? `**代码片段**:\n\`\`\`\n${codeSnippet}\n\`\`\`` : ''}
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
