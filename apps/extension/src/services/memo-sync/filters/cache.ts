/**
 * withBucketCache — skip buckets already processed; mark new buckets after fetch.
 *
 * privacy + bandwidth: once a bucket has been fetched the server has seen it
 * tied to this wallet's session. fetching it again teaches nothing new, costs
 * bandwidth, and progressively narrows what the server can infer about which
 * buckets are real (real buckets get fetched once, decoy buckets are random
 * each time — so any bucket fetched twice is real). caching avoids that
 * fingerprint.
 *
 * the cache is keyed by walletId, so multiple wallets sharing the same browser
 * don't leak each other's bucket sets via cross-cache hits.
 *
 * the storage backend is injected as a BucketStore so unit tests can use an
 * in-memory map without touching IndexedDB.
 */

import type { BucketStart, MemoFetcher, MemoFilter } from '../types';

export interface BucketStore {
  /** return true if (walletId, bucket) has been processed already. */
  has(walletId: string, bucket: BucketStart): Promise<boolean>;
  /** mark (walletId, bucket) processed. */
  put(walletId: string, bucket: BucketStart): Promise<void>;
  /** read every bucket recorded for this wallet. used by decoy filter to skip. */
  list(walletId: string): Promise<ReadonlySet<BucketStart>>;
}

export const withBucketCache = (store: BucketStore): MemoFilter =>
  (inner: MemoFetcher): MemoFetcher =>
    async function* cached(walletId, ownedBuckets, ctx) {
      const seen = await store.list(walletId);
      const fresh = new Set<BucketStart>();
      for (const b of ownedBuckets) if (!seen.has(b)) fresh.add(b);
      if (fresh.size === 0) return;

      yield* inner(walletId, fresh, ctx);

      // mark every bucket the user-set was asked to fetch as processed.
      // we mark the input set, not what inner saw — if inner widened the set
      // with decoys, we want those decoys recorded too so future syncs skip
      // them (otherwise they'd get re-rolled or worse, get fetched a second
      // time as decoys reusing the same RNG seed).
      const tasks: Promise<void>[] = [];
      for (const b of ownedBuckets) tasks.push(store.put(walletId, b));
      await Promise.all(tasks);
    };

// ────────────────────────────────────────────────────────────────────────
// concrete IndexedDB-backed BucketStore.
// uses the existing 'memo-cache' object store from zcash-worker.ts.
// key format: `${walletId}:${bucketStart}` for individual buckets,
//             `${walletId}:scanned-txids` for the existing txid set
// (preserved so we don't disrupt the worker's existing cache contract).

export interface IDBProvider {
  open(): Promise<IDBDatabase>;
}

export function idbBucketStore(provider: IDBProvider, storeName = 'memo-cache'): BucketStore {
  return {
    async has(walletId, bucket) {
      const db = await provider.open();
      return new Promise<boolean>((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(`${walletId}:${bucket}`);
        req.onsuccess = () => resolve(req.result !== undefined);
        req.onerror = () => resolve(false);
      });
    },
    async put(walletId, bucket) {
      const db = await provider.open();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).put(Date.now(), `${walletId}:${bucket}`);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },
    async list(walletId) {
      const db = await provider.open();
      return new Promise<ReadonlySet<BucketStart>>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).openCursor();
        const out = new Set<BucketStart>();
        const prefix = `${walletId}:`;
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(out); return; }
          const key = cursor.key as string;
          if (key.startsWith(prefix)) {
            const suffix = key.slice(prefix.length);
            const n = Number(suffix);
            if (!Number.isNaN(n)) out.add(n);
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },
  };
}

/** in-memory BucketStore for tests and dev modes. */
export function memoryBucketStore(): BucketStore {
  const map = new Map<string, Set<BucketStart>>();
  const set = (walletId: string) => {
    let s = map.get(walletId);
    if (!s) { s = new Set(); map.set(walletId, s); }
    return s;
  };
  return {
    async has(w, b) { return set(w).has(b); },
    async put(w, b) { set(w).add(b); },
    async list(w) { return set(w); },
  };
}
