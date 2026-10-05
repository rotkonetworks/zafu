/**
 * zcash sync status hook
 *
 * polls the node for the chain tip.
 * listens to worker sync-progress events for local scan height.
 */

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChainTip } from '../state/keyring/zidecar-client';
import { zcashClient } from '../state/keyring/zcash-backend';
import { useStore } from '../state';
import { selectZcashBackend } from '../state/networks';
import { selectActiveNetwork } from '../state/keyring';
import { activeZcashStoreId } from '../state/pockets';
import { zcashSyncHeightKey } from '../state/keyring/network-worker';
import { classifySyncFailure, stalledFailure, type SyncFailure } from '../state/sync-failure';

const DEFAULT_ZIDECAR_URL = 'https://zcash.rotko.net';
const POLL_INTERVAL = 10_000;

export interface ZcashSyncState {
  /** chain tip from zidecar */
  chainTip: ChainTip | null;
  /** local worker scan height (from sync-progress events) */
  workerSyncHeight: number;
  /** chain height from worker progress (may differ slightly from chainTip) */
  workerChainHeight: number;
  /** notes found but not in the note tree yet: they cannot be spent until then */
  notesPreparing: number;
  isLoading: boolean;
  error: Error | null;
  /**
   * The classified failure. `failure.message` is the ONLY string a user may
   * be shown; `failure.raw` is diagnostics and belongs behind a disclosure.
   */
  failure: SyncFailure | null;
}

/**
 * what the local worker reports - scan height, chain height, last failure -
 * from its events and the last stored height. asks no node, so a screen that
 * only shows local progress contacts nothing.
 */
export function useZcashWorkerSync() {
  // the worker store of the active pocket (the bare vault id for account 0)
  const activeWalletId = useStore(activeZcashStoreId);
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
  // notes found but not yet in the note tree (recovered a shard at a time)
  const [notesPreparing, setNotesPreparing] = useState(0);

  // reset on wallet switch
  useEffect(() => {
    setWorkerSyncHeight(0);
    setWorkerChainHeight(0);
    setWorkerError(null);
    setWorkerFailure(null);
    setNotesPreparing(0);
  }, [activeWalletId]);

  // listen for sync errors relayed from the worker (network-worker.ts) and
  // dispatched by the auto-sync hook on start failures
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{ walletId?: string; message?: string; code?: string; stalled?: boolean }>
      ).detail;
      if (activeWalletId && detail?.walletId && detail.walletId !== activeWalletId) {
        return;
      }
      if (typeof detail?.message === 'string') {
        setWorkerError(new Error(detail.message));
        // Classify here, once, at the boundary - so no view is ever tempted
        // to render the raw worker text.
        const failure = classifySyncFailure(detail.message, detail.code);
        setWorkerFailure(detail.stalled ? stalledFailure(failure) : failure);
      }
    };
    window.addEventListener('zcash-sync-error', handler);
    return () => window.removeEventListener('zcash-sync-error', handler);
  }, [activeWalletId]);

  // listen for worker sync-progress events - filter by active wallet
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
      if (typeof detail.preparing === 'number') {
        setNotesPreparing(detail.preparing);
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

  return { workerSyncHeight, workerChainHeight, workerError, workerFailure, notesPreparing };
}

export function useZcashSyncStatus(): ZcashSyncState {
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || DEFAULT_ZIDECAR_URL;
  const backend = useStore(selectZcashBackend);
  // Privacy: never poll the zcash zidecar when zcash is not an enabled network.
  // Otherwise a penumbra-only wallet still hammered zcash.rotko.net for GetTip /
  // GetSyncStatus on an interval - a network connection the user never opted in
  // to (reported: "why do we connect zcash if only penumbra is selected").
  // Full network isolation: only poll the zidecar when ACTIVELY on zcash, not
  // merely when zcash is enabled - a wallet viewing penumbra touches no zcash RPC.
  const zcashActive = useStore(selectActiveNetwork) === 'zcash';
  const { workerSyncHeight, workerChainHeight, workerError, workerFailure, notesPreparing } =
    useZcashWorkerSync();

  const {
    data: chainTip,
    isLoading: tipLoading,
    error: tipError,
  } = useQuery({
    // key on backend + endpoint so switching networks immediately refetches
    // with the right client instead of serving a stale one (zidecar GetTip
    // against a lightwalletd endpoint → "tip error" until extension reload).
    queryKey: ['zcashChainTip', backend, zidecarUrl],
    // Gated on zcash being enabled - a penumbra-only wallet must not poll the
    // zidecar for the chain tip.
    enabled: zcashActive,
    queryFn: () => zcashClient(zidecarUrl, backend).getTip(),
    staleTime: POLL_INTERVAL,
    refetchInterval: POLL_INTERVAL,
    retry: 2,
  });

  return {
    chainTip: chainTip ?? null,
    workerSyncHeight,
    workerChainHeight,
    notesPreparing,
    isLoading: tipLoading,
    // workerError (sync loop / auto-sync failures) takes precedence over the
    // tip query error - it's the one the user actually needs to act on.
    error: workerError ?? tipError,
    // Query errors have no structured code (they come out of fetch), so they
    // are sniffed; worker failures were classified when they arrived.
    failure: workerFailure ?? (tipError ? classifySyncFailure(tipError) : null),
  };
}
