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

import { useEffect } from 'react';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getBalanceInWorker,
  getPendingSendsInWorker,
  getPoolBalancesInWorker,
  getPoolNotesInWorker,
  type HistoryEntry,
  type PoolBalances,
  type PoolNotes,
} from '../state/keyring/network-worker';

/** Zeroed balances - the value before the first fetch resolves. */
const EMPTY_POOL_BALANCES: PoolBalances = {
  orchard: 0n,
  ironwood: 0n,
  total: 0n,
  pendingOrchard: 0n,
  pendingIronwood: 0n,
  pendingTotal: 0n,
};

/** Empty per-pool note lists - the value before the first fetch resolves. */
export const EMPTY_POOL_NOTES: PoolNotes = { orchard: [], ironwood: [] };

const workerQuery = <T>(what: string, read: (walletId: string) => Promise<T>) => {
  const options = (walletId: string | undefined) =>
    queryOptions({
      queryKey: ['zcashWorker', walletId, what],
      queryFn: () => read(walletId!),
      enabled: !!walletId,
      // a worker hiccup is not evidence the value changed: keep the last one
      retry: false,
    });
  return options;
};

/**
 * The zcash worker's local reads for one wallet store, as query options the
 * screens and their intent preloads share (routes/popup/route-preloads.ts),
 * so a screen that opens finds its numbers already in the cache.
 */
export const zcashWorkerQuery = {
  /** the shielded balance in zatoshi (home's figure, the wallets panel's) */
  balance: workerQuery('balance', async id => BigInt(await getBalanceInWorker('zcash', id))),
  pools: workerQuery('pools', id => getPoolBalancesInWorker('zcash', id)),
  notes: workerQuery('notes', id => getPoolNotesInWorker('zcash', id)),
  pending: workerQuery('pending', id => getPendingSendsInWorker('zcash', id)),
};

/** a wallet's stored birthday height (0 when it has none); shown from cache, re-read on mount */
export const zcashBirthdayQuery = (walletId: string | undefined) =>
  queryOptions({
    queryKey: ['zcashBirthday', walletId],
    queryFn: async () => {
      const key = `zcashBirthday_${walletId}`;
      const h = (await chrome.storage.local.get(key))[key];
      return typeof h === 'number' ? h : 0;
    },
    enabled: !!walletId,
  });

/**
 * Read a worker value from the cache, and re-read it on every
 * `network-sync-progress` tick for this wallet and whenever `syncTick`
 * (usually workerSyncHeight) moves. The cached value shows at once on mount.
 */
export function useWorkerValue<T>(
  options: ReturnType<ReturnType<typeof workerQuery<T>>>,
  syncTick?: number,
) {
  const client = useQueryClient();
  const query = useQuery(options);
  const [, walletId, what] = options.queryKey;
  useEffect(() => {
    if (!walletId) {
      return;
    }
    const queryKey = ['zcashWorker', walletId, what];
    const reread = () => void client.invalidateQueries({ queryKey, exact: true });
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // sync-progress events carry a walletId; ignore other wallets' ticks
      if (detail?.network === 'zcash' && (!detail.walletId || detail.walletId === walletId)) {
        reread();
      }
    };
    if (syncTick !== undefined) {
      reread();
    }
    window.addEventListener('network-sync-progress', handler);
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [client, walletId, what, syncTick]);
  return query;
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
  return useWorkerValue(zcashWorkerQuery.pools(walletId), syncTick).data ?? EMPTY_POOL_BALANCES;
}

/**
 * Per-pool note lists (orchard / ironwood) for the notes view. Each note
 * carries value / height / spent status (see DecryptedNoteWithTxid). Refetch
 * cadence matches usePoolBalances.
 */
export function usePoolNotes(walletId: string | undefined, syncTick?: number): PoolNotes {
  return useWorkerValue(zcashWorkerQuery.notes(walletId), syncTick).data ?? EMPTY_POOL_NOTES;
}

/** No sends in flight - the value before the first fetch resolves. */
const EMPTY_PENDING: HistoryEntry[] = [];

/**
 * Sends this wallet has broadcast that the chain has not confirmed, plus any
 * that provably expired. Same refetch cadence as the balances beside them,
 * which matters: the two numbers are read together and must not disagree.
 *
 * This exists so the balance can explain itself. `markNotesSpentLocally`
 * already deducts an in-flight send the instant we broadcast, so the figure
 * drops immediately - correct, but unexplained, and an unexplained drop is
 * indistinguishable from money going missing.
 */
export function usePendingSends(walletId: string | undefined, syncTick?: number): HistoryEntry[] {
  return useWorkerValue(zcashWorkerQuery.pending(walletId), syncTick).data ?? EMPTY_PENDING;
}
