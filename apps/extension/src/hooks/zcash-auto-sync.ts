/**
 * zcash auto-sync hook - manages sync lifecycle at the layout level
 *
 * this hook persists across tab navigation (home → history → inbox)
 * so the sync doesn't stop when switching pages.
 *
 * use in PopupLayout, not in individual page components.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useStore } from '../state';
import {
  selectEnabledNetworks,
  selectEffectiveKeyInfo,
  selectGetVaultUnlock,
} from '../state/keyring';
import { keyInfoSupportsNetwork } from '../state/keyring/vault-ops';
import { selectActiveZcashWallet } from '../state/wallets';
import { zcashViewKey } from '../state/zcash-view-key';
import { activePocketBirthday, activeZcashStoreId } from '../state/pockets';
import {
  spawnNetworkWorker,
  startSyncInWorker,
  startWatchOnlySyncInWorker,
  stopSyncInWorker,
  isWalletSyncing,
} from '../state/keyring/network-worker';
import { ZCASH_ORCHARD_ACTIVATION } from '../config/networks';
import { zcashClient, type ZcashBackend } from '../state/keyring/zcash-backend';
import { selectZcashBackend } from '../state/networks';
import { isMempoolWatchEnabled } from '../services/mempool-watch/strategy';

/**
 * the node has not said what it is yet: the worker asks it (GetLightdInfo)
 * before syncing. Read at start, not subscribed, so the answer arriving does
 * not restart a sync whose kind it confirmed.
 */
const nodeUnclassified = () => !useStore.getState().networks.networks.zcash.backendDetected;

/** resolve wallet birthday height from storage or chain tip.
 *  never returns below orchard activation - no point scanning pre-orchard blocks. */
export async function resolveBirthday(
  walletId: string,
  zidecarUrl: string,
  backend: ZcashBackend,
): Promise<number> {
  const birthdayKey = `zcashBirthday_${walletId}`;
  const stored = await chrome.storage.local.get(birthdayKey);
  // per-wallet birthday takes priority (user-set or auto-detected)
  if (stored[birthdayKey] && typeof stored[birthdayKey] === 'number') {
    return Math.max(ZCASH_ORCHARD_ACTIVATION, stored[birthdayKey]);
  }
  // no birthday set - default to near chain tip (new wallet = recent)
  try {
    const tip = await zcashClient(zidecarUrl, backend).getTip();
    const height = Math.floor(Math.max(ZCASH_ORCHARD_ACTIVATION, tip.height - 100) / 10000) * 10000;
    await chrome.storage.local.set({ [birthdayKey]: height });
    return height;
  } catch {
    return ZCASH_ORCHARD_ACTIVATION;
  }
}

export function useZcashAutoSync() {
  const location = useLocation();
  // zcash keeps syncing while any zafu window is open and zcash is on, whatever
  // network is on screen: switching to penumbra must not stop it
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  // and never for a penumbra-only (12-word) vault
  const zcashOn =
    useStore(selectEnabledNetworks).includes('zcash') &&
    !!selectedKeyInfo &&
    keyInfoSupportsNetwork(selectedKeyInfo, 'zcash');
  const getVaultUnlock = useStore(selectGetVaultUnlock);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';
  const zcashBackend = useStore(selectZcashBackend);
  const mempoolWatchSetting = useStore(s => s.networks.networks.zcash.mempoolWatch) ?? 'off';
  // Single-source-of-truth gate. UI and worker also enforce; we run the same
  // helper at every layer so all surfaces agree on the answer and no single
  // layer's coercion is silently authoritative.
  const mempoolWatch: 'off' | 'on' = isMempoolWatchEnabled(mempoolWatchSetting, zcashBackend)
    ? 'on'
    : 'off';

  const onLoginPage = location.pathname === '/login';
  const hasMnemonic = selectedKeyInfo?.type === 'mnemonic';
  const watchOnly = activeZcashWallet;
  const walletId = selectedKeyInfo?.id;
  // the worker store of the active pocket; the bare vault id for account 0
  const storeId = useStore(activeZcashStoreId);
  const pocketBirthday = useStore(activePocketBirthday);

  // track which walletId we started sync for, to avoid double-start
  const syncingWalletRef = useRef<string | null>(null);
  // endpoint/backend the running sync was started with. The worker loop
  // captures its client once at start, so an endpoint or backend switch
  // mid-sync would otherwise leave a stale client hammering the wrong
  // server type (HTTP 415 storm) until the wallet changes.
  const syncEndpointRef = useRef<{ endpoint: string; backend: ZcashBackend } | null>(null);
  // track in-flight stop promise so the start effect can await it on quick network switches
  const stopPromiseRef = useRef<Promise<void> | null>(null);

  // "try again", or a host that lost its worker: start again from the stored
  // height. A retry stops the running loop first, so it ends before the new one
  const [restarts, setRestarts] = useState(0);
  useEffect(() => {
    const restart = (e: Event) => {
      if (e.type === 'network-sync-lost' && (e as CustomEvent).detail?.network !== 'zcash') {
        return;
      }
      const running = syncingWalletRef.current;
      if (e.type === 'zcash-sync-retry' && running) {
        stopPromiseRef.current = stopSyncInWorker('zcash', running).catch(() => {});
      }
      setRestarts(n => n + 1);
    };
    window.addEventListener('zcash-sync-retry', restart);
    window.addEventListener('network-sync-lost', restart);
    return () => {
      window.removeEventListener('zcash-sync-retry', restart);
      window.removeEventListener('network-sync-lost', restart);
    };
  }, []);

  // eagerly pre-spawn the zcash worker while zcash is on
  // decouples WASM loading from wallet data hydration so the worker
  // is ready by the time mnemonic or watch-only sync needs it
  useEffect(() => {
    if (!zcashOn) {
      return;
    }
    if (onLoginPage) {
      return;
    }
    void spawnNetworkWorker('zcash').catch(() => {});
  }, [zcashOn, onLoginPage]);

  // mnemonic wallet sync
  useEffect(() => {
    if (!zcashOn) {
      return;
    }
    if (onLoginPage) {
      return;
    } // keyring not yet unlocked
    if (!hasMnemonic || !walletId || !storeId) {
      return;
    }

    // stop previous wallet's sync if switching to a different wallet
    const prevWallet = syncingWalletRef.current;
    if (prevWallet && prevWallet !== storeId && isWalletSyncing('zcash', prevWallet)) {
      console.log('[zcash-sync] stopping sync for previous wallet', prevWallet);
      void stopSyncInWorker('zcash', prevWallet).catch(() => {});
      syncingWalletRef.current = null;
    }

    // only bail if truly syncing with no pending stop (i.e. we started it, it's healthy)
    // and the endpoint/backend it was started with still matches the current one.
    if (isWalletSyncing('zcash', storeId) && !stopPromiseRef.current) {
      const started = syncEndpointRef.current;
      const endpointChanged =
        started !== null && (started.endpoint !== zidecarUrl || started.backend !== zcashBackend);
      if (!endpointChanged) {
        syncingWalletRef.current = storeId;
        return;
      }
      // endpoint or backend changed mid-sync - stop the stale loop the same
      // way a wallet switch does, then fall through to start a fresh sync
      // against the new server. The worker treats this abort as intentional
      // (no error surfacing), and runSync waits for the old loop to drain
      // before starting the new one.
      console.log('[zcash-sync] endpoint/backend changed, restarting sync for', storeId);
      stopPromiseRef.current = stopSyncInWorker('zcash', storeId).catch(() => {});
      syncingWalletRef.current = null;
      syncEndpointRef.current = null;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        try {
          await spawnNetworkWorker('zcash');
          if (cancelled) {
            return;
          }
          // if a stop is in flight (quick network switch back, or endpoint
          // change above), wait for it to land before starting a fresh sync
          if (stopPromiseRef.current) {
            await stopPromiseRef.current;
            stopPromiseRef.current = null;
            if (cancelled) {
              return;
            }
          }
          const vault = await getVaultUnlock(walletId);
          if (cancelled) {
            return;
          }
          // a pocket scans from its own creation height; account 0 (and a
          // pocket restored without one) from the wallet birthday
          const startHeight =
            pocketBirthday !== undefined
              ? Math.max(ZCASH_ORCHARD_ACTIVATION, pocketBirthday)
              : await resolveBirthday(walletId, zidecarUrl, zcashBackend);
          if (cancelled) {
            return;
          }
          syncingWalletRef.current = storeId;
          syncEndpointRef.current = { endpoint: zidecarUrl, backend: zcashBackend };
          console.log('[zcash-sync] starting mnemonic sync for', storeId);
          await startSyncInWorker(
            'zcash',
            storeId,
            vault,
            zidecarUrl,
            startHeight,
            zcashBackend,
            mempoolWatch,
            nodeUnclassified(),
          );
        } catch (err) {
          if (err instanceof Error && err.message.includes('keyring locked')) {
            console.log('[zcash-sync] waiting for unlock');
          } else {
            console.error('[zcash-sync] auto-sync failed:', err);
            // surface endpoint-class failures to the UI so the user can
            // hit "switch node" instead of staring at "syncing 0%"
            window.dispatchEvent(
              new CustomEvent('zcash-sync-error', {
                detail: {
                  walletId: storeId,
                  message: err instanceof Error ? err.message : String(err),
                  stalled: true,
                },
              }),
            );
          }
        }
      })();
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    zcashOn,
    onLoginPage,
    hasMnemonic,
    walletId,
    storeId,
    pocketBirthday,
    getVaultUnlock,
    zidecarUrl,
    zcashBackend,
    mempoolWatch,
    restarts,
  ]);

  // watch-only wallet sync
  useEffect(() => {
    if (!zcashOn) {
      return;
    }
    if (onLoginPage) {
      return;
    }
    if (hasMnemonic) {
      return;
    }
    if (!watchOnly) {
      return;
    }
    // a wallet without a key zafu can read says so on home (zcash-home)
    const ufvkStr = zcashViewKey(watchOnly);
    if (!ufvkStr || !walletId) {
      return;
    }

    // stop previous wallet's sync if switching
    const prevWallet = syncingWalletRef.current;
    if (prevWallet && prevWallet !== walletId && isWalletSyncing('zcash', prevWallet)) {
      console.log('[zcash-sync] stopping sync for previous wallet', prevWallet);
      void stopSyncInWorker('zcash', prevWallet).catch(() => {});
      syncingWalletRef.current = null;
    }

    // only bail if truly syncing with no pending stop, and the endpoint/backend
    // it was started with still matches the current one.
    if (isWalletSyncing('zcash', walletId) && !stopPromiseRef.current) {
      const started = syncEndpointRef.current;
      const endpointChanged =
        started !== null && (started.endpoint !== zidecarUrl || started.backend !== zcashBackend);
      if (!endpointChanged) {
        syncingWalletRef.current = walletId;
        return;
      }
      // endpoint or backend changed mid-sync - stop the stale loop the same
      // way a wallet switch does, then fall through to start a fresh sync
      // against the new server. The worker treats this abort as intentional
      // (no error surfacing), and runSync waits for the old loop to drain
      // before starting the new one.
      console.log('[zcash-sync] endpoint/backend changed, restarting sync for', walletId);
      stopPromiseRef.current = stopSyncInWorker('zcash', walletId).catch(() => {});
      syncingWalletRef.current = null;
      syncEndpointRef.current = null;
    }

    let cancelled = false;
    // no timer delay - worker is already pre-spawned by the eager effect above,
    // and this effect only fires once zcashWallets has hydrated, so start immediately
    (async () => {
      try {
        await spawnNetworkWorker('zcash');
        if (cancelled) {
          return;
        }
        // if a stop is in flight (quick network switch back, or endpoint
        // change above), wait for it to land before starting a fresh sync
        if (stopPromiseRef.current) {
          await stopPromiseRef.current;
          stopPromiseRef.current = null;
          if (cancelled) {
            return;
          }
        }
        const startHeight = await resolveBirthday(walletId, zidecarUrl, zcashBackend);
        if (cancelled) {
          return;
        }
        syncingWalletRef.current = walletId;
        syncEndpointRef.current = { endpoint: zidecarUrl, backend: zcashBackend };
        console.log('[zcash-sync] starting watch-only sync for', walletId);
        await startWatchOnlySyncInWorker(
          'zcash',
          walletId,
          ufvkStr,
          zidecarUrl,
          startHeight,
          zcashBackend,
          mempoolWatch,
          nodeUnclassified(),
        );
      } catch (err) {
        console.error('[zcash-sync] watch-only auto-sync failed:', err);
        window.dispatchEvent(
          new CustomEvent('zcash-sync-error', {
            detail: {
              walletId,
              message: err instanceof Error ? err.message : String(err),
              stalled: true,
            },
          }),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    zcashOn,
    onLoginPage,
    hasMnemonic,
    watchOnly?.id,
    watchOnly?.ufvk,
    watchOnly?.orchardFvk,
    walletId,
    zidecarUrl,
    zcashBackend,
    mempoolWatch,
    restarts,
  ]);
}
