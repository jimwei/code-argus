export const DEFAULT_RETRY_INITIAL_DELAY_MS = 2_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;
export const DEFAULT_RETRY_JITTER_RATIO = 0.25;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_PROVIDER_MAX_RETRIES = 2;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseRetryAfter(value: unknown, milliseconds: boolean, now: number): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return numeric >= 0 ? numeric * (milliseconds ? 1 : 1000) : undefined;
  if (milliseconds || typeof value !== 'string') return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Read SDK error fields, Headers/object headers, or normalized provider messages. */
export function getRetryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const headers = record?.headers ?? response?.headers;
  const headerRecord = asRecord(headers);
  const header = (name: string): unknown => {
    if (typeof headerRecord?.get === 'function') {
      return (headerRecord.get as (key: string) => unknown).call(headers, name);
    }
    const key = Object.keys(headerRecord ?? {}).find((key) => key.toLowerCase() === name);
    return key ? headerRecord?.[key] : undefined;
  };
  for (const value of [record?.retryAfterMs, record?.retry_after_ms, header('retry-after-ms')]) {
    const parsed = parseRetryAfter(value, true, now);
    if (parsed !== undefined) return parsed;
  }
  for (const value of [header('retry-after'), record?.retryAfter, record?.retry_after]) {
    const parsed = parseRetryAfter(value, false, now);
    if (parsed !== undefined) return parsed;
  }

  const message = error instanceof Error ? error.message : String(error);
  const ms =
    /(?:retry[-_ ]?after[-_ ]?ms|retryAfterMs)\s*["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(
      message
    );
  if (ms) return parseRetryAfter(ms[1], true, now);
  const seconds = /retry[-_ ]?after\s*["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)(?![\d.])/i.exec(message);
  if (seconds) return parseRetryAfter(seconds[1], false, now);
  const date =
    /retry[-_ ]?after\s*["']?\s*[:=]\s*["']?([A-Za-z]{3},\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i.exec(
      message
    );
  return date ? parseRetryAfter(date[1], false, now) : undefined;
}

/** Bounded exponential backoff with up to 25% downward jitter. */
export function calculateRetryDelayMs(
  attempt: number,
  options: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    retryAfterMs?: number;
    random?: () => number;
  } = {}
): number {
  const initial = Math.max(0, options.initialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS);
  const max = Math.max(0, options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS);
  const jitterRatio = Math.min(1, Math.max(0, options.jitterRatio ?? DEFAULT_RETRY_JITTER_RATIO));
  const random = Math.min(1, Math.max(0, (options.random ?? Math.random)()));
  const exponent = Math.max(0, attempt - 1);
  const local = Math.min(max, initial * 2 ** Math.min(exponent, 30));
  const jittered = local * (1 - jitterRatio * random);
  const hinted = options.retryAfterMs && options.retryAfterMs > 0 ? options.retryAfterMs : 0;
  return Math.min(max, Math.max(0, Math.ceil(Math.max(jittered, hinted))));
}

/** Abortable delay. The boolean contract is also used by reviewer/validator retries. */
export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Cancellation has one stable shape even when AbortController.reason is a string or object. */
export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return Object.assign(
    new Error(reason instanceof Error ? reason.message : 'OpenAI Responses request aborted', {
      cause: reason,
    }),
    { name: 'AbortError' }
  );
}

export function throwIfAborted(signal?: AbortSignal, error?: unknown): void {
  if (signal?.aborted) throw createAbortError(signal.reason);
  const name = asRecord(error)?.name;
  if (name === 'AbortError' || name === 'APIUserAbortError') throw createAbortError(error);
}

export interface StreamIdleWatchdog {
  signal: AbortSignal;
  /** Time only a network wait, including initial stream creation. */
  wait<T>(operation: () => T | PromiseLike<T>): Promise<T>;
  /** Refresh an active wait when a provider consumes an event internally. */
  touch(): void;
  wrap<T>(source: AsyncIterable<T>): AsyncIterable<T>;
  dispose(): void;
}

/** Each network event wait gets a fresh idle deadline; tools and consumers are not timed. */
export function createStreamIdleWatchdog(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS
): StreamIdleWatchdog {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(createAbortError(parentSignal?.reason));
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  if (parentSignal?.aborted) onParentAbort();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    parentSignal?.removeEventListener('abort', onParentAbort);
  };

  let refreshDeadline: (() => void) | undefined;

  async function wait<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    if (controller.signal.aborted) throw controller.signal.reason;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
          refreshDeadline = () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = setTimeout(() => {
              controller.abort(
                Object.assign(new Error(`Model stream idle timeout after ${timeoutMs}ms`), {
                  code: 'STREAM_IDLE_TIMEOUT',
                })
              );
            }, timeoutMs);
          };
          refreshDeadline();
          if (controller.signal.aborted) onAbort();
        }),
      ]);
    } finally {
      refreshDeadline = undefined;
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    signal: controller.signal,
    wait,
    touch: () => refreshDeadline?.(),
    dispose,
    async *wrap<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
      const iterator = source[Symbol.asyncIterator]();
      let done = false;
      try {
        while (true) {
          const result = await wait(() => iterator.next());
          if (result.done) {
            done = true;
            return;
          }
          yield result.value;
        }
      } finally {
        dispose();
        if (!done) {
          // A pending next() may prevent return() from ever settling. Abort the transport and
          // observe cleanup failures without making recovery depend on provider cooperation.
          if (!controller.signal.aborted) controller.abort(new Error('Model stream closed'));
          try {
            void Promise.resolve(iterator.return?.()).catch(() => {});
          } catch {
            // Preserve the stream failure if provider cleanup also fails synchronously.
          }
        }
      }
    },
  };
}
