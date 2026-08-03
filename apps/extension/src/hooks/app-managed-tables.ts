/**
 * app-managed (poker-table) multisig data feed.
 *
 * Builds the TableView[] the multisig manager renders, ready for applyTableFilter / deleteFriction /
 * isConfidentlyEmpty (state/app-managed-tables.ts).
 *
 * Money-safety: fail-closed. We fetch each hidden table's cheap cached balance (NO network sync) and
 * mark synced:false unless getMultisigStatus can PROVE sync-to-tip for that vaultId. Since
 * workerSyncHeight (hooks/zcash-sync.ts) is active-wallet-only and there is no per-vault sync RPC,
 * hidden tables resolve to synced:false — every one is treated as possibly-funded downstream.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../state';
import { selectAppManagedMultisigWallets } from '../state/wallets';
import { selectKeyInfos } from '../state/keyring';
import { useZcashSyncStatus } from './zcash-sync';
import type { TableView } from '../state/app-managed-tables';

export function useAppManagedTables(): TableView[] {
  const wallets = useStore(selectAppManagedMultisigWallets);
  const keyInfos = useStore(selectKeyInfos);
  // re-run on each scan tick, same trigger sessions.tsx uses to keep balances fresh
  const { workerSyncHeight } = useZcashSyncStatus();

  const [statuses, setStatuses] = useState<Record<string, { balanceZat: bigint; synced: boolean }>>(
    {},
  );

  useEffect(() => {
    let cancelled = false;
    const fetchAll = () => {
      for (const w of wallets) {
        if (!w.vaultId) {
          continue;
        }
        const rowId = w.id;
        // NO workerSyncHeight/chainTip passed: those prove sync for the ACTIVE wallet only, and a
        // hidden table is by definition not it. Omitting them makes getMultisigStatus fail-closed
        // to synced:false — exactly what the policy module wants for an unprovable table.
        useStore
          .getState()
          .keyRing.getMultisigStatus(w.vaultId)
          .then(s => {
            if (!cancelled) {
              setStatuses(prev => ({ ...prev, [rowId]: s }));
            }
          })
          .catch(() => {
            // rejected status → fail closed: balance 0 + unsynced ⇒ possibly-funded, stays visible,
            // gets the guarded delete path (see deleteFriction).
            if (!cancelled) {
              setStatuses(prev => ({ ...prev, [rowId]: { balanceZat: 0n, synced: false } }));
            }
          });
      }
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') {
        return;
      }
      fetchAll();
    };
    window.addEventListener('network-sync-progress', handler);
    fetchAll();
    return () => {
      cancelled = true;
      window.removeEventListener('network-sync-progress', handler);
    };
  }, [wallets, workerSyncHeight]);

  // join createdAt from the parent vault via keyInfo (in-memory; KeyInfo.createdAt === vault
  // EncryptedVault.createdAt). No decryption, no async.
  return wallets.map(w => {
    const status = statuses[w.id];
    const keyInfo = keyInfos.find(k => k.id === w.vaultId);
    return {
      wallet: w,
      // absent status (first render, before fetch resolves) ⇒ fail closed
      balanceZat: status?.balanceZat ?? 0n,
      synced: status?.synced ?? false,
      createdAt: keyInfo?.createdAt,
    };
  });
}
