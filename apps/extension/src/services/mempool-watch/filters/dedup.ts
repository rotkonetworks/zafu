/**
 * withDedup — drop a snapshot if its entry-hash set is identical to the
 * previous one.
 *
 * the mempool changes much slower than the poll interval. without dedup
 * we'd run trial decryption on the same blob every poll. with dedup, the
 * worker only sees a new snapshot when at least one tx entered or left
 * the mempool.
 *
 * comparison is done by joining sorted hex txids and string-equality on
 * the result. cheap relative to scan_actions_parallel and exact (no
 * false positives, no Bloom-style collisions).
 *
 * NOTE: an empty mempool snapshot is also yielded the first time so the
 * UI can clear any "pending" badges left over from a previous session.
 * after that, repeated empty snapshots are suppressed.
 */

import type { MempoolFetcher, MempoolFilter, MempoolSnapshot } from '../types';

/**
 * Filter-level `lastKey` lives in the filter closure, NOT inside the
 * returned generator. The generator is re-invoked on every poll iteration
 * (withPoll calls inner() fresh each cycle); putting `lastKey` inside the
 * generator function would reset it every poll, defeating the entire
 * point of dedup. With it at filter scope, dedup state persists across
 * inner() reinvocations as long as the same composed fetcher is in use.
 *
 * Lifecycle invariant: a new strategy build (e.g. mempoolWatch off→on
 * cycle) produces a fresh filter closure, so lastKey is naturally cleared
 * on toggle. The worker does not reuse a stale composed fetcher.
 */
export const withDedup = (): MempoolFilter =>
  (inner: MempoolFetcher): MempoolFetcher => {
    let lastKey: string | null = null;
    return async function* dedup(walletId, ctx) {
      for await (const snap of inner(walletId, ctx)) {
        const key = fingerprint(snap);
        if (key === lastKey) continue;
        lastKey = key;
        yield snap;
      }
    };
  };

function fingerprint(snap: MempoolSnapshot): string {
  const hexes = snap.entries.map(e => hexEncode(e.hash));
  hexes.sort();
  return hexes.join(',');
}

function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}
