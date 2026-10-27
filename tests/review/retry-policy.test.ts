import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateRetryDelayMs,
  createStreamIdleWatchdog,
  getRetryAfterMs,
  waitForRetry,
} from '../../src/review/retry-policy.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('provider retry policy', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  it.each([
    [{ retryAfterMs: 1500 }, 1500],
    [{ retry_after_ms: '1500' }, 1500],
    [{ retryAfter: 1.5 }, 1500],
    [{ retry_after: '2' }, 2000],
    [{ headers: new globalThis.Headers({ 'retry-after-ms': '1250', 'retry-after': '3' }) }, 1250],
    [{ headers: new globalThis.Headers({ 'retry-after': '2.5' }) }, 2500],
    [{ headers: { 'Retry-After': '3' } }, 3000],
    [{ response: { headers: { 'retry-after': 'Tue, 01 Jan 2030 00:00:04 GMT' } } }, 4000],
    [{ headers: { 'retry-after': 'Tue, 01 Jan 2019 00:00:00 GMT' } }, 0],
    [new Error('retry-after-ms: 1200'), 1200],
    [new Error('retryAfterMs=1200'), 1200],
    ['provider error: retry-after: 1.5', 1500],
    ['retry-after: Tue, 01 Jan 2030 00:00:04 GMT', 4000],
    [new Error('{"retry_after_ms": "1250"}'), 1250],
    [{ headers: { 'retry-after': '0' } }, 0],
    [{ headers: { 'retry-after': '-1' } }, undefined],
    [{ retryAfterMs: null }, undefined],
    [{ headers: { 'retry-after': 'not a delay' } }, undefined],
    [undefined, undefined],
  ])('parses retry hint %j as %s milliseconds', (error, expected) => {
    expect(getRetryAfterMs(error, now)).toBe(expected);
  });

  it('uses bounded exponential delays, jitter and provider hints in milliseconds', () => {
    expect(
      [1, 2, 3, 4, 99].map((attempt) => calculateRetryDelayMs(attempt, { random: () => 0 }))
    ).toEqual([2000, 4000, 8000, 10000, 10000]);
    expect(calculateRetryDelayMs(1, { random: () => 1 })).toBe(1500);
    expect(calculateRetryDelayMs(2, { random: () => 1 })).toBe(3000);
    expect(calculateRetryDelayMs(1, { retryAfterMs: 5000, random: () => 1 })).toBe(5000);
    expect(calculateRetryDelayMs(1, { retryAfterMs: 60000 })).toBe(10000);
    expect(calculateRetryDelayMs(1, { initialDelayMs: 20000 })).toBeLessThanOrEqual(10000);
  });

  it('cancels backoff for arbitrary reasons and removes its timer and listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = waitForRetry(2000, controller.signal);
    controller.abort({ user: 'cancelled' });
    expect(await pending).toBe(false);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(await waitForRetry(2000, controller.signal)).toBe(false);
  });

  it('finishes backoff and removes its listener on success', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = waitForRetry(2000, controller.signal);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('stream idle watchdog', () => {
  it('times out an unresponsive next without waiting for an unresponsive return', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const removeParent = vi.spyOn(parent.signal, 'removeEventListener');
    const watchdog = createStreamIdleWatchdog(parent.signal);
    const add = vi.spyOn(watchdog.signal, 'addEventListener');
    const remove = vi.spyOn(watchdog.signal, 'removeEventListener');
    const iterator = {
      next: vi.fn(() => new Promise<IteratorResult<number>>(() => {})),
      return: vi.fn(() => new Promise<IteratorResult<number>>(() => {})),
    };
    const wrapped = watchdog
      .wrap({ [Symbol.asyncIterator]: () => iterator })
      [Symbol.asyncIterator]();
    const failure = wrapped.next().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(299999);
    expect(watchdog.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await failure).toMatchObject({ code: 'STREAM_IDLE_TIMEOUT' });
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
    expect(removeParent).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('resets the idle deadline for every event and does not time consumer/tool work', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, 'addEventListener');
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const watchdog = createStreamIdleWatchdog(parent.signal);
    let receive: (result: IteratorResult<number>) => void = () => {};
    const source = {
      next: () =>
        new Promise<IteratorResult<number>>((resolve) => {
          receive = resolve;
        }),
      return: vi.fn(async () => ({ done: true as const, value: undefined })),
    };
    const wrapped = watchdog.wrap({ [Symbol.asyncIterator]: () => source })[Symbol.asyncIterator]();
    const first = wrapped.next();
    await vi.advanceTimersByTimeAsync(240000);
    receive({ done: false, value: 1 });
    expect(await first).toEqual({ done: false, value: 1 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600000);
    expect(watchdog.signal.aborted).toBe(false);
    const second = wrapped.next();
    await vi.advanceTimersByTimeAsync(240000);
    receive({ done: false, value: 2 });
    expect(await second).toEqual({ done: false, value: 2 });
    const end = wrapped.next();
    await vi.advanceTimersByTimeAsync(0);
    receive({ done: true, value: undefined });
    expect(await end).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
  });

  it.each(['cancelled', { custom: true }, 123, null])(
    'normalizes cancellation reason %j',
    async (reason) => {
      vi.useFakeTimers();
      const parent = new AbortController();
      const watchdog = createStreamIdleWatchdog(parent.signal);
      const source = {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
          yield 1;
        },
      };
      const iterator = watchdog.wrap(source)[Symbol.asyncIterator]();
      const failure = iterator.next().catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(0);
      parent.abort(reason);
      expect(await failure).toMatchObject({ name: 'AbortError', cause: reason });
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('also bounds initial stream creation and releases its listener', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const watchdog = createStreamIdleWatchdog(parent.signal);
    const failure = watchdog.wait(() => new Promise(() => {})).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(300000);
    expect(await failure).toMatchObject({ code: 'STREAM_IDLE_TIMEOUT' });
    watchdog.dispose();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
