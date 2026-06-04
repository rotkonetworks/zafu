/**
 * named strategies — closed enum exposed to the UI.
 *
 * 'off'  — no stream is ever opened. the fetcher is a no-op iterable.
 *          users who don't want to advertise mempool interest pick this.
 * 'on'   — poll(10s) + reconnect(exp backoff) + dedup, wrapping the
 *          provided base fetcher.
 *
 * filter composition order (innermost first, outermost last):
 *
 *   reconnect  → wraps the one-shot base so transient errors don't kill the loop
 *   dedup      → suppresses identical snapshots before they reach the worker
 *   poll       → drives the loop on a 10-second cadence
 *
 * pre-composed factory: pass the base fetcher and pick a name. that's the
 * whole public API. tests and dev can build a custom stack by composing the
 * filters directly.
 */

import { withDedup } from './filters/dedup';
import { withPoll } from './filters/poll';
import { withReconnect } from './filters/reconnect';
import type { MempoolFetcher, MempoolWatchStrategy } from './types';

export interface StrategyParams {
  /** concrete fetcher to wrap (typically zidecarMempoolFetcher(client)). */
  readonly base: MempoolFetcher;
  /** poll interval (ms). default 10_000 — matches the previous inline behavior. */
  readonly pollIntervalMs?: number;
}

export function buildStrategy(
  name: MempoolWatchStrategy,
  params: StrategyParams,
): MempoolFetcher {
  if (name === 'off') return offFetcher;

  const { base, pollIntervalMs = 10_000 } = params;
  return compose(base, [
    withReconnect({ initialDelayMs: 500, maxDelayMs: 30_000 }),
    withDedup(),
    withPoll({ intervalMs: pollIntervalMs }),
  ]);
}

/** A fetcher that yields nothing and completes immediately. */
const offFetcher: MempoolFetcher = async function* () {
  /* off — no events */
};

function compose(
  base: MempoolFetcher,
  filters: ReadonlyArray<(f: MempoolFetcher) => MempoolFetcher>,
): MempoolFetcher {
  return filters.reduce((acc, filter) => filter(acc), base);
}
