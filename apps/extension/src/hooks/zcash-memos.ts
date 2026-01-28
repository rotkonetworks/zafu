/**
 * hook to sync zcash transaction memos into the inbox
 *
 * optimizations:
 * - indexeddb cache for processed blocks (avoids re-fetching)
 * - parallel block fetching (4 concurrent requests)
 * - early exit for transactions without orchard actions
 *
 * privacy features:
 * - bucket chunking: fetch contiguous 100-block ranges instead of specific heights
 * - noise buckets: fetch random additional buckets as cover traffic (FMD-like)
 * - server sees uniform bucket requests, can't distinguish real from noise
 *
 * memo decryption happens in the zcash worker where wallet keys are loaded
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useStore } from '../state';
import { messagesSelector } from '../state/messages';
import {
  getNotesInWorker,
  decryptMemosInWorker,
  type DecryptedNoteWithTxid,
  type FoundNoteWithMemo,
} from '../state/keyring/network-worker';
import { ZidecarClient } from '../state/keyring/zidecar-client';

interface MemoSyncResult {
  synced: number;
  total: number;
  skipped: number;
  cached: number;
}

// default zidecar server (can be overridden)
const DEFAULT_ZIDECAR_URL = 'https://zidecar.rotko.net';

// parallel fetch concurrency limit
const FETCH_CONCURRENCY = 4;

// bucket size for privacy-preserving fetch
// fetching in buckets hides exact block heights from server
// e.g., note at 523 → fetch entire 500-599 range
const BUCKET_SIZE = 100;

// noise bucket ratio for FMD-like cover traffic
// for every real bucket, fetch N additional random buckets
// higher = more privacy, more bandwidth
const NOISE_BUCKET_RATIO = 2;

// minimum chain height for noise buckets (orchard activation)
const ORCHARD_ACTIVATION_HEIGHT = 1687104;

// indexeddb for block cache
const MEMO_CACHE_DB = 'zafu-memo-cache';
const MEMO_CACHE_STORE = 'processed-buckets'; // now stores buckets, not individual blocks

/**
 * open indexeddb for memo cache
 */
async function openMemoCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MEMO_CACHE_DB, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MEMO_CACHE_STORE)) {
        // key: "walletId:height", value: timestamp when processed
        db.createObjectStore(MEMO_CACHE_STORE);
      }
    };
  });
}

/**
 * get bucket start for a height
 */
function getBucketStart(height: number): number {
  return Math.floor(height / BUCKET_SIZE) * BUCKET_SIZE;
}

/**
 * generate random noise buckets for cover traffic
 * excludes buckets we actually need and already-processed buckets
 */
function generateNoiseBuckets(
  realBuckets: number[],
  excludeSet: Set<number>,
  currentTip: number,
  count: number,
): number[] {
  const noise: number[] = [];
  const realSet = new Set(realBuckets);

  // valid bucket range: orchard activation to current tip
  const minBucket = getBucketStart(ORCHARD_ACTIVATION_HEIGHT);
  const maxBucket = getBucketStart(currentTip);
  const bucketRange = (maxBucket - minBucket) / BUCKET_SIZE;

  if (bucketRange < count * 2) {
    // not enough range for noise, skip
    return [];
  }

  // generate random buckets using crypto.getRandomValues for unpredictability
  const randomBytes = new Uint32Array(count * 2);
  crypto.getRandomValues(randomBytes);

  let attempts = 0;
  for (let i = 0; i < randomBytes.length && noise.length < count && attempts < count * 10; i++) {
    const bucketIndex = randomBytes[i]! % bucketRange;
    const bucket = minBucket + bucketIndex * BUCKET_SIZE;

    // skip if it's a real bucket or already excluded
    if (realSet.has(bucket) || excludeSet.has(bucket)) {
      attempts++;
      continue;
    }

    // skip if we already picked this noise bucket
    if (noise.includes(bucket)) {
      attempts++;
      continue;
    }

    noise.push(bucket);
  }

  return noise;
}

/**
 * check if a bucket has been processed for a wallet
 */
async function isBucketProcessed(db: IDBDatabase, walletId: string, bucketStart: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tx = db.transaction(MEMO_CACHE_STORE, 'readonly');
    const store = tx.objectStore(MEMO_CACHE_STORE);
    const request = store.get(`${walletId}:${bucketStart}`);
    request.onsuccess = () => resolve(request.result !== undefined);
    request.onerror = () => resolve(false);
  });
}

/**
 * mark a bucket as processed for a wallet
 */
async function markBucketProcessed(db: IDBDatabase, walletId: string, bucketStart: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEMO_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(MEMO_CACHE_STORE);
    const request = store.put(Date.now(), `${walletId}:${bucketStart}`);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * clear memo cache for a wallet (useful for re-sync)
 */
export async function clearMemoCache(walletId: string): Promise<void> {
  const db = await openMemoCache();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEMO_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(MEMO_CACHE_STORE);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        if ((cursor.key as string).startsWith(`${walletId}:`)) {
          cursor.delete();
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * fetch a noise bucket (cover traffic - fetch and discard)
 * looks identical to real bucket fetch from server's perspective
 */
async function fetchNoiseBucket(
  client: ZidecarClient,
  bucketStart: number,
  currentTip: number,
): Promise<number> {
  const bucketEnd = Math.min(bucketStart + BUCKET_SIZE - 1, currentTip);
  let fetched = 0;

  for (let height = bucketStart; height <= bucketEnd; height++) {
    try {
      // fetch but don't process - just cover traffic
      await client.getBlockTransactions(height);
      fetched++;
    } catch {
      // ignore errors for noise buckets
    }
  }

  return fetched;
}

/**
 * process a single bucket (fetch all blocks in range, decrypt only where we have notes)
 */
async function processBucket(
  client: ZidecarClient,
  walletId: string,
  bucketStart: number,
  notesByHeight: Map<number, DecryptedNoteWithTxid[]>,
  processedTxids: Set<string>,
  messages: ReturnType<typeof messagesSelector>,
  db: IDBDatabase,
  currentTip: number,
): Promise<{ synced: number; blocksFetched: number }> {
  let synced = 0;
  let blocksFetched = 0;

  // fetch all blocks in this bucket (privacy: server sees linear range)
  const bucketEnd = Math.min(bucketStart + BUCKET_SIZE - 1, currentTip);

  for (let height = bucketStart; height <= bucketEnd; height++) {
    try {
      const { txs } = await client.getBlockTransactions(height);
      blocksFetched++;

      // only process if we have notes at this specific height
      const heightNotes = notesByHeight.get(height);
      if (!heightNotes || heightNotes.length === 0) continue;

      // build cmx set for quick lookup
      const cmxSet = new Set(heightNotes.map(n => n.cmx));

      for (const { data: txBytes } of txs) {
        // skip small transactions (can't have orchard bundle)
        if (txBytes.length < 200) continue;

        // decrypt memos using worker
        const foundMemos = await decryptMemosInWorker('zcash', walletId, txBytes);

        for (const memo of foundMemos) {
          if (!memo.memo_is_text || !memo.memo.trim()) continue;
          if (!cmxSet.has(memo.cmx)) continue;

          const matchingNote = heightNotes.find(n => n.cmx === memo.cmx);
          if (!matchingNote) continue;
          if (processedTxids.has(matchingNote.txid)) continue;

          const direction = memo.value > 0 ? 'received' : 'sent';

          await messages.addMessage({
            network: 'zcash',
            txId: matchingNote.txid,
            blockHeight: height,
            timestamp: Date.now(),
            content: memo.memo,
            recipientAddress: '',
            direction,
            read: direction === 'sent',
            amount: zatoshiToZec(memo.value),
          });

          processedTxids.add(matchingNote.txid);
          synced++;
        }
      }
    } catch (err) {
      console.error(`failed to process block ${height}:`, err);
      // continue with next block in bucket
    }
  }

  // mark entire bucket as processed
  await markBucketProcessed(db, walletId, bucketStart);

  return { synced, blocksFetched };
}

/**
 * process multiple buckets in parallel
 */
async function processBucketBatch(
  client: ZidecarClient,
  walletId: string,
  bucketStarts: number[],
  notesByHeight: Map<number, DecryptedNoteWithTxid[]>,
  processedTxids: Set<string>,
  messages: ReturnType<typeof messagesSelector>,
  db: IDBDatabase,
  currentTip: number,
): Promise<{ synced: number; blocksFetched: number; errors: number }> {
  let totalSynced = 0;
  let totalBlocksFetched = 0;
  let errors = 0;

  const results = await Promise.allSettled(
    bucketStarts.map(bucketStart =>
      processBucket(client, walletId, bucketStart, notesByHeight, processedTxids, messages, db, currentTip)
    )
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalSynced += result.value.synced;
      totalBlocksFetched += result.value.blocksFetched;
    } else {
      errors++;
      console.error('bucket failed:', result.reason);
    }
  }

  return { synced: totalSynced, blocksFetched: totalBlocksFetched, errors };
}

/**
 * hook to fetch and sync zcash memos
 *
 * privacy-preserving with bucket chunking:
 * - fetches blocks in contiguous ranges (buckets of 100)
 * - server sees linear range requests, not specific heights
 * - caches at bucket level to avoid re-fetching
 */
export function useZcashMemos(walletId: string, zidecarUrl: string = DEFAULT_ZIDECAR_URL) {
  const messages = useStore(messagesSelector);
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null);

  const syncMemos = useMutation({
    mutationFn: async (): Promise<MemoSyncResult> => {
      // 1. get all notes from zcash worker
      const notes = await getNotesInWorker('zcash', walletId);
      if (notes.length === 0) {
        setSyncProgress(null);
        return { synced: 0, total: 0, skipped: 0, cached: 0 };
      }

      // 2. open cache db and get current chain tip
      const db = await openMemoCache();
      const client = new ZidecarClient(zidecarUrl);
      const { height: currentTip } = await client.getTip();

      // 3. filter notes that have txid and haven't been processed yet
      const existingMessages = messages.getByNetwork('zcash');
      const processedTxids = new Set(existingMessages.map(m => m.txId));

      const notesToProcess = notes.filter(n => n.txid && !processedTxids.has(n.txid));
      if (notesToProcess.length === 0) {
        setSyncProgress(null);
        return { synced: 0, total: notes.length, skipped: notes.length, cached: 0 };
      }

      // 4. group notes by block height
      const notesByHeight = new Map<number, DecryptedNoteWithTxid[]>();
      for (const note of notesToProcess) {
        const existing = notesByHeight.get(note.height) ?? [];
        existing.push(note);
        notesByHeight.set(note.height, existing);
      }

      // 5. determine which buckets we need (privacy: fetch whole buckets)
      const bucketSet = new Set<number>();
      for (const height of notesByHeight.keys()) {
        bucketSet.add(getBucketStart(height));
      }

      // 6. filter out already-cached buckets
      const allBuckets = Array.from(bucketSet).sort((a, b) => a - b);
      const uncachedBuckets: number[] = [];
      const cachedBucketSet = new Set<number>();
      let cached = 0;

      for (const bucket of allBuckets) {
        if (await isBucketProcessed(db, walletId, bucket)) {
          cached++;
          cachedBucketSet.add(bucket);
        } else {
          uncachedBuckets.push(bucket);
        }
      }

      if (uncachedBuckets.length === 0) {
        setSyncProgress(null);
        return { synced: 0, total: notes.length, skipped: notes.length - notesToProcess.length, cached };
      }

      // 7. generate noise buckets for cover traffic (FMD-like privacy)
      const noiseCount = uncachedBuckets.length * NOISE_BUCKET_RATIO;
      const noiseBuckets = generateNoiseBuckets(
        uncachedBuckets,
        cachedBucketSet,
        currentTip,
        noiseCount,
      );
      const noiseBucketSet = new Set(noiseBuckets);

      // 8. combine and shuffle real + noise buckets
      // server sees uniform bucket requests, can't distinguish real from noise
      const allFetchBuckets = [...uncachedBuckets, ...noiseBuckets];
      shuffleArray(allFetchBuckets);

      // 9. fetch and process buckets
      let synced = 0;
      let processed = 0;
      const totalBlocks = allFetchBuckets.length * BUCKET_SIZE;

      setSyncProgress({ current: 0, total: totalBlocks });

      // process buckets in parallel batches
      for (let i = 0; i < allFetchBuckets.length; i += FETCH_CONCURRENCY) {
        const bucketBatch = allFetchBuckets.slice(i, i + FETCH_CONCURRENCY);

        // separate real vs noise in this batch
        const realInBatch = bucketBatch.filter(b => !noiseBucketSet.has(b));
        const noiseInBatch = bucketBatch.filter(b => noiseBucketSet.has(b));

        // process real and noise in parallel
        const [realResult, noiseBlocksFetched] = await Promise.all([
          realInBatch.length > 0
            ? processBucketBatch(
                client,
                walletId,
                realInBatch,
                notesByHeight,
                processedTxids,
                messages,
                db,
                currentTip,
              )
            : { synced: 0, blocksFetched: 0, errors: 0 },
          Promise.all(noiseInBatch.map(b => fetchNoiseBucket(client, b, currentTip))),
        ]);

        synced += realResult.synced;
        processed += realResult.blocksFetched + noiseBlocksFetched.reduce((a, b) => a + b, 0);

        setSyncProgress({ current: processed, total: totalBlocks });
      }

      setSyncProgress(null);
      return {
        synced,
        total: notes.length,
        skipped: notes.length - notesToProcess.length,
        cached,
      };
    },
  });

  return {
    syncMemos: syncMemos.mutate,
    isSyncing: syncMemos.isPending,
    syncProgress,
    syncResult: syncMemos.data,
    syncError: syncMemos.error,
  };
}

/**
 * hook to get unread zcash memo count for badge
 */
export function useZcashUnreadCount() {
  const messages = useStore(messagesSelector);
  return messages.getByNetwork('zcash').filter(m => !m.read && m.direction === 'received').length;
}

/**
 * decrypt memos from a single transaction (standalone function)
 */
export async function decryptTransactionMemos(
  walletId: string,
  txBytes: Uint8Array
): Promise<FoundNoteWithMemo[]> {
  try {
    return await decryptMemosInWorker('zcash', walletId, txBytes);
  } catch (err) {
    console.error('failed to decrypt transaction memos:', err);
    return [];
  }
}

// --- helpers ---

/** convert zatoshis to ZEC string */
function zatoshiToZec(zatoshis: number): string {
  return (zatoshis / 100_000_000).toFixed(8);
}

/** fisher-yates shuffle using crypto random */
function shuffleArray<T>(array: T[]): void {
  const randomBytes = new Uint32Array(array.length);
  crypto.getRandomValues(randomBytes);

  for (let i = array.length - 1; i > 0; i--) {
    const j = randomBytes[i]! % (i + 1);
    [array[i], array[j]] = [array[j]!, array[i]!];
  }
}
