/**
 * zcash sync status hook
 *
 * polls zidecar for sync pipeline status + chain tip.
 * listens to worker sync-progress events for local scan height.
 */

import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ZidecarClient, type SyncStatus, type ChainTip } from '../state/keyring/zidecar-client';
import { LightwalletdClient } from '../state/keyring/lightwalletd-client';
import type { ZcashClient } from '../state/keyring/zcash-backend';
import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';
import { zcashSyncHeightKey } from '../state/keyring/network-worker';
import { classifySyncFailure, type SyncFailure } from '../state/sync-failure';

const DEFAULT_ZIDECAR_URL = 'https://zcash.rotko.net';
const POLL_INTERVAL = 10_000;

export interface ZcashSyncState {
  /** zidecar pipeline status (gigaproof, epochs, etc) */
  syncStatus: SyncStatus | null;
  /** chain tip from zidecar */
  chainTip: ChainTip | null;
  /** local worker scan height (from sync-progress events) */
  workerSyncHeight: number;
  /** chain height from worker progress (may differ slightly from chainTip) */
  workerChainHeight: number;
  isLoading: boolean;
  error: Error | null;
  /**
   * The classified failure. `failure.message` is the ONLY string a user may
   * be shown; `failure.raw` is diagnostics and belongs behind a disclosure.
   */
  failure: SyncFailure | null;
}

export function useZcashSyncStatus(): ZcashSyncState {
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || DEFAULT_ZIDECAR_URL;
  const backend = useStore(s => s.networks.networks.zcash.backend) ?? 'zidecar';
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const activeWalletId = selectedKeyInfo?.id;
  const [workerSyncHeight, setWorkerSyncHeight] = useState(0);
  const [workerChainHeight, setWorkerChainHeight] = useState(0);
  // Last sync error captured from the worker (via zcash-sync-error events).
  // Cleared on wallet switch and whenever sync makes forward progress. Lets
  // the sync bar surface "endpoint won't respond - switch node" instead of
  // silently sitting at 0%.
  const [workerError, setWorkerError] = useState<Error | null>(null);
  // The same failure, classified. Kept alongside the Error so callers that
  // only need "did sync fail" are unaffected.
  const [workerFailure, setWorkerFailure] = useState<SyncFailure | null>(null);

  // reset on wallet switch
  useEffect(() => {
    setWorkerSyncHeight(0);
    setWorkerChainHeight(0);
    setWorkerError(null);
    setWorkerFailure(null);
  }, [activeWalletId]);

  // listen for sync errors relayed from the worker (network-worker.ts) and
  // dispatched by the auto-sync hook on start failures
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ walletId?: string; message?: string; code?: string }>)
        .detail;
      if (activeWalletId && detail?.walletId && detail.walletId !== activeWalletId) {
        return;
      }
      if (typeof detail?.message === 'string') {
        setWorkerError(new Error(detail.message));
        // Classify here, once, at the boundary — so no view is ever tempted
        // to render the raw worker text.
        setWorkerFailure(classifySyncFailure(detail.message, detail.code));
      }
    };
    window.addEventListener('zcash-sync-error', handler);
    return () => window.removeEventListener('zcash-sync-error', handler);
  }, [activeWalletId]);

  // listen for worker sync-progress events — filter by active wallet
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') {
        return;
      }
      // only accept events for the currently active wallet
      if (activeWalletId && detail.walletId && detail.walletId !== activeWalletId) {
        return;
      }
      if (typeof detail.currentHeight === 'number') {
        setWorkerSyncHeight(detail.currentHeight);
        // forward progress means the endpoint is responding - clear stale error
        setWorkerError(null);
        setWorkerFailure(null);
      }
      if (typeof detail.chainHeight === 'number') {
        setWorkerChainHeight(detail.chainHeight);
        setWorkerError(null);
        setWorkerFailure(null);
      }
    };

    window.addEventListener('network-sync-progress', handler);
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [activeWalletId]);

  // Hydrate from the last height the worker reported for THIS wallet, so a
  // freshly-opened popup does not spend its first seconds claiming the scan
  // is at 0 while the worker boots. Re-runs on wallet switch (the reset
  // effect above zeroes it first), and the per-wallet key means one wallet's
  // progress can never be shown for another's.
  useEffect(() => {
    if (!activeWalletId) {
      return;
    }
    const key = zcashSyncHeightKey(activeWalletId);
    chrome.storage.local.get(key, result => {
      const stored = result[key];
      if (typeof stored === 'number' && stored > 0) {
        setWorkerSyncHeight(h => Math.max(h, stored));
      }
    });
  }, [activeWalletId]);

  const client = useCallback(
    (): ZcashClient =>
      backend === 'lightwalletd'
        ? new LightwalletdClient(zidecarUrl)
        : new ZidecarClient(zidecarUrl),
    [zidecarUrl, backend],
  );

  const {
    data: syncStatus,
    isLoading: syncLoading,
    error: syncError,
  } = useQuery({
    queryKey: ['zcashSyncStatus', backend, zidecarUrl],
    // GetSyncStatus is a zidecar-only RPC; public lightwalletd endpoints lack it
    enabled: backend === 'zidecar',
    queryFn: () => client().getSyncStatus(),
    staleTime: POLL_INTERVAL,
    refetchInterval: POLL_INTERVAL,
    retry: 2,
  });

  const {
    data: chainTip,
    isLoading: tipLoading,
    error: tipError,
  } = useQuery({
    // key on backend + endpoint so switching networks immediately refetches
    // with the right client instead of serving a stale one (zidecar GetTip
    // against a lightwalletd endpoint → "tip error" until extension reload).
    queryKey: ['zcashChainTip', backend, zidecarUrl],
    queryFn: () => client().getTip(),
    staleTime: POLL_INTERVAL,
    refetchInterval: POLL_INTERVAL,
    retry: 2,
  });

  return {
    syncStatus: syncStatus ?? null,
    chainTip: chainTip ?? null,
    workerSyncHeight,
    workerChainHeight,
    isLoading: syncLoading || tipLoading,
    // workerError (sync loop / auto-sync failures) takes precedence over the
    // status/tip query errors - it's the one the user actually needs to act on.
    error: workerError ?? syncError ?? tipError,
    // Query errors have no structured code (they come out of fetch), so they
    // are sniffed; worker failures were classified when they arrived.
    failure:
      workerFailure ??
      ((syncError ?? tipError) ? classifySyncFailure(syncError ?? tipError) : null),
  };
}
