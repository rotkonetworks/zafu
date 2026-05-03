import { localExtStorage } from '@repo/storage-chrome/local';

const PENUMBRA_DB_PREFIX = 'viewdata/penumbra';
const ZCASH_DB_NAMES = ['zafu-zcash', 'zafu-memo-cache'];

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
 * Run any pending IDB clears requested via the clear-cache UI before wallet
 * services start. Must be awaited prior to the first call to startWalletServices,
 * since opened IDB connections would block deletion.
 */
export const performPendingClears = async (): Promise<void> => {
  const pending = await localExtStorage.get('pendingClearCache');
  if (!pending || pending.length === 0) return;

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
