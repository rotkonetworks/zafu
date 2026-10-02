import { useEffect, useState } from 'react';
import type { ZcashWalletJson } from '../state/wallets';
import { getBalanceInWorker } from '../state/keyring/network-worker';
import { useZcashSyncStatus } from './zcash-sync';

/**
 * Each multisig wallet's balance, from the zcash worker's local notes (no
 * network). Sync writes notes keyed by vaultId, not the wallet row id, so the
 * lookup uses vaultId and the result is keyed by row id. Re-reads on every
 * sync tick so a row stays in step with home. Off zcash it reads nothing.
 */
export const useMultisigBalances = (
  wallets: readonly ZcashWalletJson[],
  enabled: boolean,
): Record<string, bigint> => {
  const { workerSyncHeight } = useZcashSyncStatus();
  const [balances, setBalances] = useState<Record<string, bigint>>({});

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const fetchAll = () => {
      for (const w of wallets) {
        if (w.vaultId) {
          getBalanceInWorker('zcash', w.vaultId)
            .then(bal => setBalances(prev => ({ ...prev, [w.id]: BigInt(bal) })))
            .catch(() => undefined);
        }
      }
    };
    const onProgress = (e: Event) =>
      (e as CustomEvent<{ network?: string }>).detail?.network === 'zcash' && fetchAll();
    window.addEventListener('network-sync-progress', onProgress);
    fetchAll();
    return () => window.removeEventListener('network-sync-progress', onProgress);
  }, [wallets, workerSyncHeight, enabled]);

  return balances;
};
