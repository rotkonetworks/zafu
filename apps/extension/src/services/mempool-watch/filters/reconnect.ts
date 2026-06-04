/**
 * withReconnect — catch errors from inner and retry with exponential backoff.
 *
 * sits between withPoll and the base fetcher: when the base throws (network
 * down, server 5xx, transient parse error), reconnect waits and re-invokes
 * inner instead of bubbling the error up. emits onStatus({kind:'reconnecting'})
 * so the UI can show a "reconnecting…" badge.
 *
 * if the inner succeeds, the backoff counter resets. if the user aborts
 * mid-backoff, reconnect returns cleanly without another attempt.
 *
 * NOTE: this filter is best placed *inside* withPoll, so the outer poll
 * loop sees inner as "always succeeds eventually" and just paces snapshots
 * on its interval. swapping the order means a single transient error kills
 * the whole poll loop until the next outer iteration.
 */

import type { MempoolFetcher, MempoolFilter, MempoolStreamStatus } from '../types';

export interface ReconnectOptions {
  /** first retry delay in ms. doubles each attempt up to maxDelayMs. default 500. */
  readonly initialDelayMs?: number;
  /** max retry delay in ms. default 60_000. */
  readonly maxDelayMs?: number;
  /** max consecutive attempts before giving up (0 = unlimited). default 0. */
  readonly maxAttempts?: number;
  /** sleep slice for abort responsiveness. default 250ms. */
  readonly stepMs?: number;
}

export const withReconnect = (opts: ReconnectOptions = {}): MempoolFilter => {
  const initialDelayMs = Math.max(0, opts.initialDelayMs ?? 500);
  const maxDelayMs = Math.max(initialDelayMs, opts.maxDelayMs ?? 60_000);
  const maxAttempts = Math.max(0, opts.maxAttempts ?? 0);
  const stepMs = Math.max(50, opts.stepMs ?? 250);

  return (inner: MempoolFetcher): MempoolFetcher =>
    async function* reconnecting(walletId, ctx) {
      let attempt = 0;
      while (!ctx.signal.aborted) {
        try {
          for await (const snap of inner(walletId, ctx)) {
            if (ctx.signal.aborted) return;
            // any successful event resets the backoff counter
            attempt = 0;
            yield snap;
          }
          // inner completed cleanly — let the outer (poll) loop drive the next call
          return;
        } catch (err) {
          if (ctx.signal.aborted) return;
          attempt += 1;
          if (maxAttempts > 0 && attempt > maxAttempts) {
            const status: MempoolStreamStatus = {
              kind: 'error',
              error: err instanceof Error ? err.message : String(err),
            };
            ctx.onStatus?.(status);
            throw err;
          }
          const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
          ctx.onStatus?.({ kind: 'reconnecting', attempt, nextAttemptInMs: delay });
          await sleepAbortable(delay, stepMs, ctx.signal);
        }
      }
    };
};

async function sleepAbortable(
  totalMs: number,
  stepMs: number,
  signal: AbortSignal,
): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0 && !signal.aborted) {
    const slice = Math.min(stepMs, remaining);
    await new Promise<void>(resolve => setTimeout(resolve, slice));
    remaining -= slice;
  }
}
