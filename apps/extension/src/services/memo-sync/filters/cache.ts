/**
 * withBucketCache - record the real buckets fetched for a wallet.
 *
 * the decoy filter reads the record (excludeStore) so a decoy never lands on
 * a bucket this wallet already fetched for real: a bucket fetched as a decoy
 * and again for real would mark itself as real.
 *
 * every bucket it is handed is fetched, even one fetched before: the caller
 * passes only buckets holding a note whose memo is not read yet, and a new
 * payment can land in a bucket fetched for an older one. skipping it lost
 * that memo for good. fetching it again tells the server the bucket is real,
 * which it could already guess from the first fetch; a lost memo is worse.
 *
 * the record is keyed by walletId, so wallets sharing a browser don't leak
 * each other's bucket sets.
 */

import type { BucketStart, MemoFilter } from '../types';

export interface BucketStore {
  /** return true if (walletId, bucket) has been fetched for real. */
  has(walletId: string, bucket: BucketStart): Promise<boolean>;
  /** mark (walletId, bucket) fetched for real. */
  put(walletId: string, bucket: BucketStart): Promise<void>;
  /** read every bucket recorded for this wallet. used by decoy filter to skip. */
  list(walletId: string): Promise<ReadonlySet<BucketStart>>;
}

export const withBucketCache =
  (store: BucketStore): MemoFilter =>
  inner =>
    async function* cached(walletId, ownedBuckets, ctx) {
      if (ownedBuckets.size === 0) {
        return;
      }
      // recorded: buckets whose event arrived AND that were in our own input
      // (real-only, as cache is outermost). an errored bucket yields no event
      // and stays unrecorded; a decoy added by an inner filter is never
      // recorded, keeping the decoy universe over [activation, tip] full
      const succeeded = new Set<BucketStart>();
      for await (const event of inner(walletId, ownedBuckets, ctx)) {
        if (ownedBuckets.has(event.bucketStart)) {
          succeeded.add(event.bucketStart);
        }
        yield event;
      }
      await Promise.all([...succeeded].map(b => store.put(walletId, b)));
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
      return new Promise<boolean>(resolve => {
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
          if (!cursor) {
            resolve(out);
            return;
          }
          const key = cursor.key as string;
          if (key.startsWith(prefix)) {
            const suffix = key.slice(prefix.length);
            const n = Number(suffix);
            if (!Number.isNaN(n)) {
              out.add(n);
            }
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
    if (!s) {
      s = new Set();
      map.set(walletId, s);
    }
    return s;
  };
  return {
    async has(w, b) {
      return set(w).has(b);
    },
    async put(w, b) {
      set(w).add(b);
    },
    async list(w) {
      return set(w);
    },
  };
}
