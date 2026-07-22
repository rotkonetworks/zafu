/**
 * zcash per-pool balance + note hooks (NU6.3 dual-pool)
 *
 * Thin wrappers over the worker's per-pool exposure (get-pool-balances /
 * get-notes, relayed through network-worker.ts). They mirror the single-balance
 * fetch the home screen already runs: an initial read plus a re-fetch on every
 * `network-sync-progress` tick for the active wallet, so the numbers track sync
 * without a parallel polling path.
 *
 * Orchard is the legacy (migrate-only) pool; ironwood is the NU6.3 active pool.
 * Records persisted before the ironwood rollout carry no pool tag and count as
 * orchard - that classification lives in the worker / relay, not here.
 */

import { useEffect, useState } from 'react';
import {
  getPoolBalancesInWorker,
  getPoolNotesInWorker,
  type PoolBalances,
  type PoolNotes,
} from '../state/keyring/network-worker';

/** Zeroed balances - the value before the first fetch resolves. */
const EMPTY_POOL_BALANCES: PoolBalances = { orchard: 0n, ironwood: 0n, total: 0n };

/** Empty per-pool note lists - the value before the first fetch resolves. */
const EMPTY_POOL_NOTES: PoolNotes = { orchard: [], ironwood: [] };

/**
 * Subscribe to a worker fetch that re-runs on `network-sync-progress` for the
 * given wallet. Returns the latest resolved value (or `empty` before the first
 * resolve / when no wallet is selected). Shared by the two hooks below so the
 * refetch wiring lives in exactly one place.
 *
 * `walletId` is included in the effect deps: switching wallets re-subscribes
 * and re-fetches. `syncTick` (usually workerSyncHeight) lets a caller force a
 * refetch on cadence changes it already tracks.
 */
function useWorkerPoolValue<T>(
  fetcher: (walletId: string) => Promise<T>,
  empty: T,
  walletId: string | undefined,
  syncTick?: number,
): T {
  const [value, setValue] = useState<T>(empty);

  useEffect(() => {
    if (!walletId) {
      setValue(empty);
      return;
    }
    let cancelled = false;
    const refetch = () => {
      fetcher(walletId)
        .then(v => {
          if (!cancelled) {
            setValue(v);
          }
        })
        .catch(() => {});
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') {
        return;
      }
      // sync-progress events carry a walletId; ignore other wallets' ticks
      if (detail.walletId && detail.walletId !== walletId) {
        return;
      }
      refetch();
    };
    window.addEventListener('network-sync-progress', handler);
    refetch();
    return () => {
      cancelled = true;
      window.removeEventListener('network-sync-progress', handler);
    };
    // re-subscribe + refetch on wallet switch or sync-height change. fetcher /
    // empty are caller-inlined but semantically stable, so they're left out of
    // the deps deliberately to avoid a refetch every render.
  }, [walletId, syncTick]);

  return value;
}

/**
 * Per-pool spendable balances (zatoshi bigints) for a wallet.
 *
 * `total` equals the single balance the home screen reads via
 * getBalanceInWorker; `orchard` / `ironwood` are that total split by pool.
 * Pass `syncTick` (e.g. workerSyncHeight from useZcashSyncStatus) to also
 * refetch when the local scan height advances.
 */
export function usePoolBalances(walletId: string | undefined, syncTick?: number): PoolBalances {
  return useWorkerPoolValue(
    id => getPoolBalancesInWorker('zcash', id),
    EMPTY_POOL_BALANCES,
    walletId,
    syncTick,
  );
}

/**
 * Per-pool note lists (orchard / ironwood) for the notes view. Each note
 * carries value / height / spent status (see DecryptedNoteWithTxid). Refetch
 * cadence matches usePoolBalances.
 */
export function usePoolNotes(walletId: string | undefined, syncTick?: number): PoolNotes {
  return useWorkerPoolValue(
    id => getPoolNotesInWorker('zcash', id),
    EMPTY_POOL_NOTES,
    walletId,
    syncTick,
  );
}
