/**
 * withPoll — turn a one-shot snapshot fetcher into a long-running one.
 *
 * loop:
 *   1. call inner() once, yield every snapshot it produces
 *   2. sleep until the next "phase slot" (with optional jitter)
 *   3. repeat until ctx.signal aborts
 *
 * privacy notes (hdevalence pass):
 *   - per-user phase offset is the strongest fingerprint a regular polling
 *     loop creates. an indexer can identify a returning client across IP
 *     changes by phase alone if every wallet starts polling at its own
 *     wall-clock t0 and never resyncs.
 *   - mitigation A (phase-align): schedule polls at
 *     floor(now / intervalMs) * intervalMs + intervalMs. all clients in
 *     the world target the same wall-clock seconds, so phase offset is
 *     zero and only jitter remains.
 *   - mitigation B (jitter): add uniform random [-jitterMs, +jitterMs] to
 *     each wake-up. removes the "perfectly periodic" pattern that
 *     differential network observers exploit.
 *
 * the wait between iterations sleeps in small chunks so abort is
 * responsive even with a long interval.
 */

import type { MempoolFetcher, MempoolFilter } from '../types';

export interface PollOptions {
  /** delay between iterations, in milliseconds. */
  readonly intervalMs: number;
  /**
   * symmetric jitter applied to each wake-up: actual delay is
   * [intervalMs - jitterMs, intervalMs + jitterMs]. set to 0 to disable.
   * default: 30% of intervalMs (e.g. 3s for a 10s base).
   */
  readonly jitterMs?: number;
  /**
   * align wake-ups to wall-clock multiples of intervalMs. when true (default),
   * every client in the world wakes at the same seconds-since-epoch slot,
   * killing per-user phase as a fingerprint.
   */
  readonly phaseAlign?: boolean;
  /** sleep slice for abort responsiveness. defaults to 250ms. */
  readonly stepMs?: number;
  /** RNG override for tests. defaults to Math.random. */
  readonly rng?: () => number;
}

export const withPoll = (opts: PollOptions): MempoolFilter => {
  const intervalMs = Math.max(0, opts.intervalMs);
  const jitterMs = Math.max(0, opts.jitterMs ?? Math.floor(intervalMs * 0.3));
  const phaseAlign = opts.phaseAlign ?? true;
  const stepMs = Math.max(50, opts.stepMs ?? 250);
  const rng = opts.rng ?? Math.random;

  return (inner: MempoolFetcher): MempoolFetcher =>
    async function* polling(walletId, ctx) {
      while (!ctx.signal.aborted) {
        for await (const snap of inner(walletId, ctx)) {
          if (ctx.signal.aborted) return;
          yield snap;
        }
        if (intervalMs === 0) continue;
        const sleepFor = nextDelay(intervalMs, jitterMs, phaseAlign, rng, Date.now());
        await sleepAbortable(sleepFor, stepMs, ctx.signal);
      }
    };
};

/**
 * Compute the delay until the next wake-up. Exposed for tests.
 *
 *   base       = phaseAlign ? (nextSlot - now) : intervalMs
 *   jitter     = uniform[-jitterMs, +jitterMs]
 *   delay      = max(0, base + jitter)
 */
export function nextDelay(
  intervalMs: number,
  jitterMs: number,
  phaseAlign: boolean,
  rng: () => number,
  now: number,
): number {
  const base = phaseAlign
    ? (Math.floor(now / intervalMs) + 1) * intervalMs - now
    : intervalMs;
  const jitter = jitterMs > 0 ? (rng() * 2 - 1) * jitterMs : 0;
  return Math.max(0, base + jitter);
}

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
