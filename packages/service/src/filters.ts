/**
 * The filters that every service in this repo ends up wanting, in the pattern's
 * one-concern-per-filter form. Each is a pure transformation of a service into
 * another service: none of them call the network, none of them inspect the
 * request, and none of them rewrite the response.
 *
 * Every filter takes and returns the same `Ctx`, so they stack in any order
 * (`compose(trace, timeout, retry)`), and every filter preserves the metadata a
 * caller put in the context - they copy it and add what they own.
 */

import type { Service, ServiceContext, ServiceFilter } from './service';

/**
 * A service call that did not complete in time. Distinct from an abort: an
 * upstream abort means the caller walked away, this means the deadline passed.
 */
export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';

  constructor(readonly ms: number) {
    super(`timed out after ${ms}ms`);
  }
}

/**
 * A service that is switched off for this request (feature flag, no endpoint
 * configured, wallet locked). Carries a machine-readable reason so callers can
 * map it to their own error taxonomy without parsing prose.
 */
export class UnavailableError extends Error {
  override readonly name = 'UnavailableError';

  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Bound the call, and make the bound MEAN something: when the deadline passes we
 * abort the signal handed to the inner service, so a service that can cancel
 * (fetch, a socket read) actually stops working, instead of leaving work running
 * for a result nobody will look at. That is Finagle's interrupt, spelled with
 * AbortSignal.
 *
 * An abort from the caller propagates down immediately rather than waiting for
 * the deadline.
 */
export function timeout(ms: number): ServiceFilter {
  return <Req, Res, Ctx extends ServiceContext>(inner: Service<Req, Res, Ctx>) =>
    (req: Req, ctx: Ctx) => {
      const ctrl = new AbortController();
      const caller = ctx.signal;
      const relayAbort = (): void => ctrl.abort(caller?.reason);
      if (caller) {
        if (caller.aborted) {
          relayAbort();
        } else {
          caller.addEventListener('abort', relayAbort, { once: true });
        }
      }

      const expiry = Promise.withResolvers<never>();
      const timer = setTimeout(() => {
        const error = new TimeoutError(ms);
        ctrl.abort(error);
        expiry.reject(error);
      }, ms);

      return Promise.race([
        inner(req, { ...ctx, signal: ctrl.signal } as Ctx),
        expiry.promise,
      ]).finally(() => {
        clearTimeout(timer);
        caller?.removeEventListener('abort', relayAbort);
      });
    };
}

export interface RetryOptions {
  /** total attempts, >= 1. `1` means no retry at all. */
  readonly attempts: number;
  /**
   * base backoff in ms; attempt n waits `backoffMs * 2^(n-1)`. Default 0, which
   * retries immediately - correct on a local extension bridge, wrong on a relay,
   * so a network-backed strategy must set it.
   */
  readonly backoffMs?: number;
  /** which failures deserve another attempt; default: all of them. */
  readonly retryOn?: (error: unknown) => boolean;
  /** injectable sleep, so tests never wait on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * Re-issue a failed call. Retries stop on: success, the last attempt, a failure
 * `retryOn` refuses, or a caller abort - a caller that walked away must not have
 * work started on its behalf.
 */
export function retry(opts: RetryOptions): ServiceFilter {
  const attempts = Math.max(1, Math.floor(opts.attempts));
  const base = opts.backoffMs ?? 0;
  const retryOn = opts.retryOn ?? ((): boolean => true);
  const sleep = opts.sleep ?? realSleep;

  return <Req, Res, Ctx extends ServiceContext>(inner: Service<Req, Res, Ctx>) =>
    async (req: Req, ctx: Ctx): Promise<Res> => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (ctx.signal?.aborted) {
          throw ctx.signal.reason ?? new Error('aborted');
        }
        try {
          return await inner(req, ctx);
        } catch (error) {
          lastError = error;
          const worthAnotherTry = attempt < attempts && retryOn(error) && !ctx.signal?.aborted;
          if (!worthAnotherTry) {
            throw error;
          }
          if (base > 0) {
            await sleep(base * 2 ** (attempt - 1));
          }
        }
      }
      throw lastError;
    };
}

export interface TraceEvent {
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: unknown;
}

export interface TraceOptions {
  readonly onComplete: (event: TraceEvent) => void;
  /** injectable clock; default is performance.now() where it exists. */
  readonly now?: () => number;
}

const defaultNow = (): number =>
  typeof performance === 'undefined' ? Date.now() : performance.now();

/** Record how a call went (duration, outcome) without changing it. */
export function trace(opts: TraceOptions): ServiceFilter {
  const now = opts.now ?? defaultNow;
  return <Req, Res, Ctx extends ServiceContext>(inner: Service<Req, Res, Ctx>) =>
    async (req: Req, ctx: Ctx): Promise<Res> => {
      const start = now();
      try {
        const res = await inner(req, ctx);
        opts.onComplete({ durationMs: now() - start, ok: true });
        return res;
      } catch (error) {
        opts.onComplete({ durationMs: now() - start, ok: false, error });
        throw error;
      }
    };
}

/**
 * Refuse the call when the service is switched off - the filter form of the
 * wallet's feature-flag and "not configured" checks, so the base service never
 * has to know about either.
 *
 * `onDisabled` is for services with a degraded mode (answer from cache); without
 * it the call fails with `UnavailableError` rather than hanging or lying.
 */
export function gate<Req, Res>(
  isEnabled: (req: Req) => boolean | Promise<boolean>,
  onDisabled?: (req: Req) => Promise<Res>,
): ServiceFilter {
  return <Req2, Res2, Ctx extends ServiceContext>(inner: Service<Req2, Res2, Ctx>) =>
    async (req: Req2, ctx: Ctx): Promise<Res2> => {
      // the predicates are pinned to the caller's request/response types, which
      // the polymorphic filter signature cannot express: the stack decides them,
      // so the request is re-typed at this one boundary.
      const typed = req as unknown as Req;
      if (await isEnabled(typed)) {
        return inner(req, ctx);
      }
      if (onDisabled) {
        return (await onDisabled(typed)) as unknown as Res2;
      }
      throw new UnavailableError('service is disabled');
    };
}
