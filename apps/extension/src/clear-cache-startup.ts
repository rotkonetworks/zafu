import { localExtStorage } from '@repo/storage-chrome/local';

const PENUMBRA_DB_PREFIX = 'viewdata/penumbra';
// 'zafu-memo-cache' used to be listed here and in four other clear paths.
// No such database has ever existed — the memo cache is the 'memo-cache'
// OBJECT STORE inside 'zafu-zcash' (see zcash-worker.ts). Deleting a
// non-existent database succeeds silently, so all five call sites looked
// like they were clearing the memo cache and were clearing nothing. The
// cache is in fact cleared, correctly, by dropping 'zafu-zcash'.
const ZCASH_DB_NAMES = ['zafu-zcash'];

// A resync must wipe only the SYNC CACHE, never the user's own data.
//   - 'sent' is the send history - the ONLY record that a tx was a send. A
//     self-send returns its funds to the user's own address, so without this
//     record the payment shows merely as "received". Dropping the whole DB
//     erased it on every resync.
//   - 'wallets' is the wallet registry.
// Everything else (notes, spent nullifiers, meta/sync-height, witnesses, memo
// cache) is derived from the chain and is safe to rebuild.
const ZCASH_SYNC_CACHE_STORES = ['notes', 'spent', 'meta', 'memo-cache', 'witnesses-ironwood'];

const deleteDb = (name: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => {
      console.log('[clear-startup] deleted:', name);
      resolve();
    };
    req.onerror = () => {
      console.warn('[clear-startup] delete failed:', name, req.error);
      reject(req.error ?? new Error(`delete ${name} failed`));
    };
    // at startup no wallet services hold connections, so onblocked should not fire
    req.onblocked = () => {
      console.warn('[clear-startup] delete blocked at startup (unexpected):', name);
      resolve();
    };
  });

/**
 * Clear the zcash SYNC CACHE stores in place, preserving 'sent' (send history)
 * and 'wallets' (registry). Replaces the old "drop the whole database" resync,
 * which destroyed the user's send history - after which their own past sends,
 * and every self-send, reappeared as anonymous "received" notes.
 *
 * Falls back to nothing (resolves) when the DB or a store is absent: a wallet
 * that never synced has no cache to clear.
 */
const clearZcashSyncCache = (name: string): Promise<void> =>
  new Promise(resolve => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name);
    } catch (e) {
      console.warn('[clear-startup] open for cache-clear threw:', name, e);
      resolve();
      return;
    }
    req.onsuccess = () => {
      const db = req.result;
      const stores = ZCASH_SYNC_CACHE_STORES.filter(s => db.objectStoreNames.contains(s));
      if (stores.length === 0) {
        db.close();
        resolve();
        return;
      }
      try {
        const tx = db.transaction(stores, 'readwrite');
        for (const s of stores) {
          tx.objectStore(s).clear();
        }
        tx.oncomplete = () => {
          db.close();
          console.log('[clear-startup] cleared zcash sync cache, kept sent + wallets:', name);
          resolve();
        };
        tx.onerror = () => {
          db.close();
          console.warn('[clear-startup] cache-clear tx failed:', name, tx.error);
          resolve();
        };
      } catch (e) {
        db.close();
        console.warn('[clear-startup] cache-clear tx threw:', name, e);
        resolve();
      }
    };
    req.onerror = () => {
      console.warn('[clear-startup] open for cache-clear failed:', name, req.error);
      resolve();
    };
    // Caller terminates the worker first, so no live connection should block us.
    req.onblocked = () => {
      console.warn('[clear-startup] cache-clear blocked (worker still connected?):', name);
      resolve();
    };
  });

/**
 * Delete the zcash databases and WAIT for the result.
 *
 * Callers must terminate the zcash worker first. An open connection does not
 * make `deleteDatabase` fail — it fires `onblocked` and never completes — so
 * a fire-and-forget delete is indistinguishable from a successful one. This
 * resolves either way but logs loudly when the data was not actually
 * removed, which is the case a user clearing their wallet needs to know
 * about.
 */
export const deleteZcashDatabases = async (): Promise<void> => {
  // Resync = clear the sync cache, NOT the user's send history. Preserving the
  // 'sent' store is what keeps a past send (and every self-send) labelled
  // "sent" instead of resurfacing as an anonymous "received" note after a
  // resync. The DB itself is kept so 'sent' + 'wallets' survive.
  await Promise.all(
    ZCASH_DB_NAMES.map(name =>
      clearZcashSyncCache(name).catch(e => {
        console.warn('[clear-cache] zcash cache clear failed:', name, e);
      }),
    ),
  );
};

/**
 * Run any pending IDB clears requested via the clear-cache UI before wallet
 * services start. Must be awaited prior to the first call to startWalletServices,
 * since opened IDB connections would block deletion.
 */
export const performPendingClears = async (): Promise<void> => {
  const pending = await localExtStorage.get('pendingClearCache');
  if (!pending || pending.length === 0) {
    return;
  }

  console.log('[clear-startup] performing pending clears:', pending);

  if (pending.includes('penumbra')) {
    try {
      const dbs = await indexedDB.databases();
      const targets = dbs
        .map(d => d.name)
        .filter((n): n is string => !!n && n.startsWith(PENUMBRA_DB_PREFIX));
      await Promise.all(targets.map(name => deleteDb(name).catch(() => {})));
    } catch (e) {
      console.warn('[clear-startup] penumbra enumerate error:', e);
    }
    await Promise.all([
      localExtStorage.remove('fullSyncHeight'),
      localExtStorage.remove('compactFrontierBlockHeight'),
      localExtStorage.remove('params'),
    ]);
  }

  if (pending.includes('zcash')) {
    // cache-only clear, same as the direct resync path: keep 'sent' + 'wallets'
    await Promise.all(ZCASH_DB_NAMES.map(name => clearZcashSyncCache(name).catch(() => {})));
  }

  await localExtStorage.remove('pendingClearCache');
  console.log('[clear-startup] done');
};
