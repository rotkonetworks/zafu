/**
 * zcash sync status hook
 *
 * polls zidecar for sync pipeline status + chain tip.
 * listens to worker sync-progress events for local scan height.
 */

import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ZidecarClient, type SyncStatus, type ChainTip } from '../state/keyring/zidecar-client';
import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';

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
}

export function useZcashSyncStatus(): ZcashSyncState {
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || DEFAULT_ZIDECAR_URL;
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const activeWalletId = selectedKeyInfo?.id;
  const [workerSyncHeight, setWorkerSyncHeight] = useState(0);
  const [workerChainHeight, setWorkerChainHeight] = useState(0);

  // reset on wallet switch
  useEffect(() => {
    setWorkerSyncHeight(0);
    setWorkerChainHeight(0);
  }, [activeWalletId]);

  // listen for worker sync-progress events — filter by active wallet
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') return;
      // only accept events for the currently active wallet
      if (activeWalletId && detail.walletId && detail.walletId !== activeWalletId) return;
      if (typeof detail.currentHeight === 'number') {
        setWorkerSyncHeight(detail.currentHeight);
      }
      if (typeof detail.chainHeight === 'number') {
        setWorkerChainHeight(detail.chainHeight);
      }
    };

    window.addEventListener('network-sync-progress', handler);
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [activeWalletId]);

  // also try to read persisted sync height on mount
  useEffect(() => {
    chrome.storage.local.get('zcashSyncHeight', (result) => {
      if (result['zcashSyncHeight'] && typeof result['zcashSyncHeight'] === 'number') {
        setWorkerSyncHeight(h => Math.max(h, result['zcashSyncHeight'] as number));
      }
    });
  }, []);

  const client = useCallback(() => new ZidecarClient(zidecarUrl), [zidecarUrl]);

  const {
    data: syncStatus,
    isLoading: syncLoading,
    error: syncError,
  } = useQuery({
    queryKey: ['zcashSyncStatus'],
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
    queryKey: ['zcashChainTip'],
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
    error: (syncError ?? tipError) as Error | null,
  };
}
