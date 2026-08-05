import { localExtStorage } from '@repo/storage-chrome/local';

const PENUMBRA_DB_PREFIX = 'viewdata/penumbra';
// 'zafu-memo-cache' used to be listed here and in four other clear paths.
// No such database has ever existed — the memo cache is the 'memo-cache'
// OBJECT STORE inside 'zafu-zcash' (see zcash-worker.ts). Deleting a
// non-existent database succeeds silently, so all five call sites looked
// like they were clearing the memo cache and were clearing nothing. The
// cache is in fact cleared, correctly, by dropping 'zafu-zcash'.
const ZCASH_DB_NAMES = ['zafu-zcash'];

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
  await Promise.all(
    ZCASH_DB_NAMES.map(name =>
      deleteDb(name).catch(e => {
        console.warn('[clear-cache] zcash db delete failed:', name, e);
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
    await Promise.all(ZCASH_DB_NAMES.map(name => deleteDb(name).catch(() => {})));
  }

  await localExtStorage.remove('pendingClearCache');
  console.log('[clear-startup] done');
};
