/**
 * The swap quote preload. The request the swap screen opened with, and the
 * prices it was shown, are kept in session memory (never on disk, never a
 * deposit address: only dry prices). A swap entry point pressed puts those
 * prices back at once (dimmed while stale) and asks the routes already
 * allowed for a fresh one, so a price is there as the screen paints.
 *
 * Only a press, or the swap screen itself, counts as intent: nothing here runs
 * on a load, a timer or in the service worker, and a route not yet allowed is
 * never asked.
 */

import { hashKey, type QueryClient } from '@tanstack/react-query';
import type { Quote, QuoteRequest } from './provider';
import { egressViewQuery, gates, lastQuery, pairOf, quoteQuery, REFRESH_MS } from './live';

export interface SwapPreloadCtx {
  client: QueryClient;
  /** the active pocket's store, as the screen keys its prices */
  wallet: string;
}

const reqKey = (wallet: string) => `swapWarm:${wallet}`;
const quotesKey = (wallet: string) => `swapQuotes:${wallet}`;
/** how long a kept price may be shown again, dimmed, while a fresh one is asked */
const KEEP_MS = 10 * 60_000;
const KEPT = 6;

interface Kept {
  key: readonly unknown[];
  at: number;
  /** the quote as json, its bigints as {$n} */
  quote: string;
}

const big = (_: string, v: unknown) => (typeof v === 'bigint' ? { $n: v.toString() } : v);
const unbig = (_: string, v: unknown) =>
  v &&
  typeof v === 'object' &&
  Object.keys(v).length === 1 &&
  typeof (v as { $n?: unknown }).$n === 'string'
    ? BigInt((v as { $n: string }).$n)
    : v;

const session = async <T>(key: string): Promise<T | undefined> =>
  (await chrome.storage.session.get(key))[key] as T | undefined;

/** the request the screen opened with, kept for the next press */
export const keepSwapPreload = (wallet: string, req: QuoteRequest) =>
  chrome.storage.session.set({ [reqKey(wallet)]: req }).catch(() => undefined);

/** every price the screen is shown, kept as it lands (the newest few); returns the unsubscribe */
export const keepSwapQuotes = (client: QueryClient, wallet: string): (() => void) => {
  let kept = session<Kept[]>(quotesKey(wallet)).then(
    k => k ?? [],
    () => [],
  );
  return client.getQueryCache().subscribe(e => {
    const q = e.query;
    if (
      e.type !== 'updated' ||
      e.action.type !== 'success' ||
      q.queryKey[0] !== 'swap-quote' ||
      q.queryKey[1] !== wallet
    ) {
      return;
    }
    const entry = {
      key: q.queryKey,
      at: q.state.dataUpdatedAt,
      quote: JSON.stringify(q.state.data, big),
    };
    kept = kept.then(list => {
      const next = [entry, ...list.filter(k => hashKey(k.key) !== q.queryHash)].slice(0, KEPT);
      void chrome.storage.session.set({ [quotesKey(wallet)]: next }).catch(() => undefined);
      return next;
    });
  });
};

/** put the kept prices back in the cache, as old as they are; never an expired one */
export const seedSwapQuotes = async (client: QueryClient, wallet: string, now = Date.now()) => {
  for (const k of (await session<Kept[]>(quotesKey(wallet))) ?? []) {
    const quote = JSON.parse(k.quote, unbig) as Quote;
    if (
      !client.getQueryData(k.key) &&
      now - k.at < KEEP_MS &&
      (quote.expiresAt ?? Infinity) > now + REFRESH_MS
    ) {
      client.setQueryData(k.key, quote, { updatedAt: k.at });
    }
  }
};

export const preloadSwapQuote = async ({ client, wallet }: SwapPreloadCtx): Promise<void> => {
  const [req] = await Promise.all([
    session<QuoteRequest>(reqKey(wallet)),
    seedSwapQuotes(client, wallet),
  ]);
  if (!req) {
    return;
  }
  void client.prefetchQuery(lastQuery);
  const views = await client.fetchQuery(egressViewQuery);
  for (const g of gates(pairOf(req), views)) {
    if (!g.line) {
      void client.prefetchQuery(quoteQuery(g.route, wallet, req));
    }
  }
};
