import { describe, expect, it, vi } from 'vitest';

import { gate, retry, timeout, trace, TimeoutError, UnavailableError } from './filters';
import { compose, detachedContext, type Service } from './service';

describe('timeout', () => {
  it('rejects with TimeoutError and interrupts the inner service', async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    // the inner service records the interrupt and stays pending: the deadline is
    // the only thing that settles this call, so the test asserts on that alone.
    const slow: Service<void, never> = (_req, ctx) =>
      new Promise(() => {
        ctx.signal?.addEventListener('abort', () => {
          sawAbort = true;
        });
      });

    const svc = compose(timeout(5_000))(slow);
    const call = svc(undefined, detachedContext);
    // handled BEFORE the clock advances: a rejection observed only after
    // `advanceTimersByTimeAsync` comes back reads as a stray unhandled rejection.
    const observed: unknown[] = [];
    void call.catch((error: unknown) => observed.push(error));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(call).rejects.toBeInstanceOf(TimeoutError);
    expect(observed).toHaveLength(1);
    expect(sawAbort).toBe(true);
    vi.useRealTimers();
  });

  it('passes a fast response through and clears the deadline', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const svc = compose(timeout(1_000))((n: number) => Promise.resolve(n + 1));

    await expect(svc(1, detachedContext)).resolves.toBe(2);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('propagates a caller abort instead of inventing a deadline failure', async () => {
    const ctrl = new AbortController();
    const walking = new Error('caller left');
    const slow: Service<void, never> = (_req, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason));
      });

    const svc = compose(timeout(1_000))(slow);
    const pending = svc(undefined, { signal: ctrl.signal });
    ctrl.abort(walking);

    await expect(pending).rejects.toBe(walking);
  });
});

describe('retry', () => {
  const failing = (failures: number, log: number[]): Service<number, number> => {
    let calls = 0;
    return req => {
      calls += 1;
      log.push(calls);
      return calls <= failures
        ? Promise.reject(new Error(`attempt ${calls} failed`))
        : Promise.resolve(req);
    };
  };

  it('re-issues until success and reports the attempts', async () => {
    const log: number[] = [];
    const svc = compose(retry({ attempts: 3, sleep: () => Promise.resolve() }))(failing(2, log));

    await expect(svc(7, detachedContext)).resolves.toBe(7);
    expect(log).toEqual([1, 2, 3]);
  });

  it('backs off exponentially from the base delay', async () => {
    const slept: number[] = [];
    const log: number[] = [];
    const svc = compose(
      retry({
        attempts: 4,
        backoffMs: 10,
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
      }),
    )(failing(3, log));

    await expect(svc(1, detachedContext)).resolves.toBe(1);
    expect(slept).toEqual([10, 20, 40]);
  });

  it('gives up immediately when retryOn refuses the failure', async () => {
    const log: number[] = [];
    const svc = compose(retry({ attempts: 5, retryOn: () => false, sleep: async () => {} }))(
      failing(1, log),
    );

    await expect(svc(1, detachedContext)).rejects.toThrow('attempt 1 failed');
    expect(log).toEqual([1]);
  });

  it('does not start another attempt after the caller aborts', async () => {
    const ctrl = new AbortController();
    const log: number[] = [];
    const svc = compose(
      retry({
        attempts: 5,
        // backoff must be non-zero for the injected sleep to run at all: that is
        // the window in which the caller walks away here.
        backoffMs: 10,
        sleep: () => {
          ctrl.abort(new Error('done waiting'));
          return Promise.resolve();
        },
      }),
    )(failing(4, log));

    await expect(svc(1, { signal: ctrl.signal })).rejects.toThrow('done waiting');
    expect(log).toEqual([1]);
  });
});

describe('trace', () => {
  it('reports success with a duration from the injected clock', async () => {
    const events: { durationMs: number; ok: boolean }[] = [];
    let clock = 100;
    const svc = compose(
      trace({
        now: () => {
          clock += 25;
          return clock;
        },
        onComplete: event => events.push({ durationMs: event.durationMs, ok: event.ok }),
      }),
    )((n: number) => Promise.resolve(n));

    await expect(svc(1, detachedContext)).resolves.toBe(1);
    expect(events).toEqual([{ durationMs: 25, ok: true }]);
  });

  it('reports failure with the error and rethrows it', async () => {
    const boom = new Error('relay refused');
    const events: { ok: boolean; error?: unknown }[] = [];
    const svc = compose(
      trace({ onComplete: event => events.push({ ok: event.ok, error: event.error }) }),
    )(() => Promise.reject(boom));

    await expect(svc(undefined, detachedContext)).rejects.toBe(boom);
    expect(events).toEqual([{ ok: false, error: boom }]);
  });
});

describe('gate', () => {
  const service: Service<string, string> = req => Promise.resolve(`served ${req}`);

  it('passes through when enabled', async () => {
    const svc = compose(gate<string, string>(() => true))(service);
    await expect(svc('a', detachedContext)).resolves.toBe('served a');
  });

  it('fails with UnavailableError when disabled and no fallback is given', async () => {
    const svc = compose(gate<string, string>(() => false))(service);
    await expect(svc('a', detachedContext)).rejects.toBeInstanceOf(UnavailableError);
  });

  it('uses the degraded mode when one is supplied', async () => {
    const svc = compose(
      gate<string, string>(
        () => false,
        req => Promise.resolve(`cached ${req}`),
      ),
    )(service);

    await expect(svc('a', detachedContext)).resolves.toBe('cached a');
  });
});
