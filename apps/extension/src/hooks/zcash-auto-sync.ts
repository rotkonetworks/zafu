/**
 * zcash auto-sync hook — manages sync lifecycle at the layout level
 *
 * this hook persists across tab navigation (home → history → inbox)
 * so the sync doesn't stop when switching pages.
 *
 * use in PopupLayout, not in individual page components.
 */

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useStore } from '../state';
import { selectActiveNetwork, selectEffectiveKeyInfo, selectGetMnemonic } from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import {
  spawnNetworkWorker,
  startSyncInWorker,
  startWatchOnlySyncInWorker,
  stopSyncInWorker,
  isWalletSyncing,
} from '../state/keyring/network-worker';
import { ZCASH_ORCHARD_ACTIVATION } from '../config/networks';
import { isPro } from '../state/license';
import { deriveRingVrfSeed } from '../state/identity';
import { ZidecarClient } from '../state/keyring/zidecar-client';

/** resolve wallet birthday height from storage or chain tip.
 *  never returns below orchard activation — no point scanning pre-orchard blocks. */
async function resolveBirthday(walletId: string, zidecarUrl: string): Promise<number> {
  const birthdayKey = `zcashBirthday_${walletId}`;
  const stored = await chrome.storage.local.get(birthdayKey);
  // per-wallet birthday takes priority (user-set or auto-detected)
  if (stored[birthdayKey] && typeof stored[birthdayKey] === 'number') {
    return Math.max(ZCASH_ORCHARD_ACTIVATION, stored[birthdayKey] as number);
  }
  // no birthday set — default to near chain tip (new wallet = recent)
  try {
    const { ZidecarClient } = await import('../state/keyring/zidecar-client');
    const tip = await new ZidecarClient(zidecarUrl).getTip();
    const height = Math.floor(Math.max(ZCASH_ORCHARD_ACTIVATION, tip.height - 100) / 10000) * 10000;
    await chrome.storage.local.set({ [birthdayKey]: height });
    return height;
  } catch {
    return ZCASH_ORCHARD_ACTIVATION;
  }
}

export function useZcashAutoSync() {
  const location = useLocation();
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const getMnemonic = useStore(selectGetMnemonic);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';

  const onLoginPage = location.pathname === '/login';
  const hasMnemonic = selectedKeyInfo?.type === 'mnemonic';
  const watchOnly = activeZcashWallet;
  const walletId = selectedKeyInfo?.id;

  // track which walletId we started sync for, to avoid double-start
  const syncingWalletRef = useRef<string | null>(null);

  // eagerly pre-spawn zcash worker when on zcash network
  // decouples WASM loading from wallet data hydration so the worker
  // is ready by the time mnemonic or watch-only sync needs it
  useEffect(() => {
    if (activeNetwork !== 'zcash') return;
    if (onLoginPage) return;
    void spawnNetworkWorker('zcash').catch(() => {});
  }, [activeNetwork, onLoginPage]);

  // mnemonic wallet sync
  useEffect(() => {
    if (activeNetwork !== 'zcash') return;
    if (onLoginPage) return; // keyring not yet unlocked
    if (!hasMnemonic || !walletId) return;

    // stop previous wallet's sync if switching to a different wallet
    const prevWallet = syncingWalletRef.current;
    if (prevWallet && prevWallet !== walletId && isWalletSyncing('zcash', prevWallet)) {
      console.log('[zcash-sync] stopping sync for previous wallet', prevWallet);
      void stopSyncInWorker('zcash', prevWallet).catch(() => {});
      syncingWalletRef.current = null;
    }

    if (isWalletSyncing('zcash', walletId)) {
      syncingWalletRef.current = walletId;
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        try {
          await spawnNetworkWorker('zcash');
          if (cancelled) return;
          const mnemonic = await getMnemonic(walletId);
          if (cancelled) return;
          const startHeight = await resolveBirthday(walletId, zidecarUrl);
          if (cancelled) return;
          // generate ring VRF session proof for pro priority sync
          if (isPro(useStore.getState())) {
            try {
              const seed = deriveRingVrfSeed(mnemonic);
              await useStore.getState().ringVrf.refreshRing(zidecarUrl, seed);
              await useStore.getState().ringVrf.newSessionProof();
              // inject proof headers into all ZidecarClient requests
              ZidecarClient.extraHeaders = () => useStore.getState().ringVrf.getProofHeaders();
            } catch { /* ring VRF is optional - free tier still works */ }
          }

          syncingWalletRef.current = walletId;
          console.log('[zcash-sync] starting mnemonic sync for', walletId);
          await startSyncInWorker('zcash', walletId, mnemonic, zidecarUrl, startHeight);
        } catch (err) {
          if (err instanceof Error && err.message.includes('keyring locked')) {
            console.log('[zcash-sync] waiting for unlock');
          } else {
            console.error('[zcash-sync] auto-sync failed:', err);
          }
        }
      })();
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeNetwork, onLoginPage, hasMnemonic, walletId, getMnemonic, zidecarUrl]);

  // watch-only wallet sync
  useEffect(() => {
    if (activeNetwork !== 'zcash') return;
    if (onLoginPage) return;
    if (hasMnemonic) return;
    if (!watchOnly) return;
    const ufvkStr = watchOnly.ufvk ?? (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
    if (!ufvkStr || !walletId) return;

    // stop previous wallet's sync if switching
    const prevWallet = syncingWalletRef.current;
    if (prevWallet && prevWallet !== walletId && isWalletSyncing('zcash', prevWallet)) {
      console.log('[zcash-sync] stopping sync for previous wallet', prevWallet);
      void stopSyncInWorker('zcash', prevWallet).catch(() => {});
      syncingWalletRef.current = null;
    }

    if (isWalletSyncing('zcash', walletId)) {
      syncingWalletRef.current = walletId;
      return;
    }

    let cancelled = false;
    // no timer delay — worker is already pre-spawned by the eager effect above,
    // and this effect only fires once zcashWallets has hydrated, so start immediately
    (async () => {
      try {
        await spawnNetworkWorker('zcash');
        if (cancelled) return;
        const startHeight = await resolveBirthday(walletId, zidecarUrl);
        if (cancelled) return;
        syncingWalletRef.current = walletId;
        console.log('[zcash-sync] starting watch-only sync for', walletId);
        await startWatchOnlySyncInWorker('zcash', walletId, ufvkStr, zidecarUrl, startHeight);
      } catch (err) {
        console.error('[zcash-sync] watch-only auto-sync failed:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeNetwork, onLoginPage, hasMnemonic, watchOnly?.id, watchOnly?.ufvk, watchOnly?.orchardFvk, walletId, zidecarUrl]);

  // stop sync when switching away from zcash network
  useEffect(() => {
    if (activeNetwork === 'zcash') return;
    const syncedWallet = syncingWalletRef.current;
    if (syncedWallet && isWalletSyncing('zcash', syncedWallet)) {
      console.log('[zcash-sync] stopping sync (switched away from zcash)');
      void stopSyncInWorker('zcash', syncedWallet).catch(() => {});
      syncingWalletRef.current = null;
    }
  }, [activeNetwork]);
}
