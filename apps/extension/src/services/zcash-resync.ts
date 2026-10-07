/**
 * Rescan and retry for the zcash wallet in view, as plain services so the
 * home sync strip and the settings zcash screen run the same code. Both read
 * the store at call time; neither holds React state.
 */

import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { zcashViewKey } from '../state/zcash-view-key';
import { activeAccountIndex, activePockets } from '../state/pockets';
import { pocketStoreId } from '../state/pocket-id';
import { selectZcashBackend } from '../state/networks';
import {
  spawnNetworkWorker,
  terminateNetworkWorker,
  markWalletSyncing,
  startSyncInWorker,
  startWatchOnlySyncInWorker,
  zcashSyncHeightKey,
} from '../state/keyring/network-worker';
import { deleteZcashDatabases } from '../clear-cache-startup';
import { rescanStartHeight } from '../utils/zcash-blocks';

/** the wallet in view and how to start its sync from a height */
const target = () => {
  const s = useStore.getState();
  const key = selectEffectiveKeyInfo(s);
  if (!key) {
    return undefined;
  }
  const zidecarUrl = s.networks.networks.zcash.endpoint || 'https://zcash.rotko.net';
  // what the node said it is, or the guess until it has (never zidecar for a
  // third-party host); an unclassified node is asked first by the worker
  const backend = selectZcashBackend(s);
  const detect = !s.networks.networks.zcash.backendDetected;
  const storeId = pocketStoreId(key.id, activeAccountIndex(s));
  const pockets = activePockets(s);
  const watch = key.type === 'mnemonic' ? undefined : selectActiveZcashWallet(s);
  const ufvk = zcashViewKey(watch);

  const start = async (from: number | undefined) => {
    if (key.type === 'mnemonic') {
      const vault = await s.keyRing.getVaultUnlock(key.id);
      await startSyncInWorker('zcash', storeId, vault, zidecarUrl, from, backend, 'off', detect);
    } else if (ufvk) {
      await startWatchOnlySyncInWorker(
        'zcash',
        storeId,
        ufvk,
        zidecarUrl,
        from,
        backend,
        'off',
        detect,
      );
    }
  };

  return {
    walletId: key.id,
    storeId,
    storeIds: pockets.length > 0 ? pockets.map(p => pocketStoreId(key.id, p.account)) : [key.id],
    start,
  };
};

/**
 * Forget every scanned note and read the chain again from `requested`.
 *
 * A rescan DELETES the note database and writes this height as the new
 * birthday, so any note received before it is never found again. A height
 * below orchard activation is meaningless and one near the tip forgets
 * everything owned, so it is clamped (rescanStartHeight). Resolves to the
 * height actually used.
 */
export const rescanZcash = async (requested: number): Promise<number | undefined> => {
  const t = target();
  if (!t || !Number.isFinite(requested)) {
    return undefined;
  }
  const height = rescanStartHeight(requested);
  // terminate first so the in-memory commitment tree is dropped; the delete
  // is awaited because one against a still-open database hangs on onblocked
  try {
    terminateNetworkWorker('zcash');
  } catch {}
  await deleteZcashDatabases();
  await chrome.storage.local.set({ [`zcashBirthday_${t.walletId}`]: height });
  // every pocket's resume hint goes: the shared tree is gone, so a stale hint
  // would resume an inactive pocket from a height the tree no longer has.
  // the legacy global key goes too, so an old install's value cannot outlive it.
  await chrome.storage.local.remove(['zcashSyncHeight', ...t.storeIds.map(zcashSyncHeightKey)]);
  // mark syncing before starting so the auto-sync hook does not race a duplicate
  await new Promise(r => setTimeout(r, 500));
  await spawnNetworkWorker('zcash');
  markWalletSyncing('zcash', t.storeId);
  await t.start(height);
  return height;
};

/**
 * Resume after a failure from the height already reached. Unlike a rescan it
 * keeps the notes: the auto-sync hook stops the running loop and starts it
 * again with the same birthday and store it always uses.
 */
export const retryZcashSync = (): void => {
  window.dispatchEvent(new Event('zcash-sync-retry'));
};
