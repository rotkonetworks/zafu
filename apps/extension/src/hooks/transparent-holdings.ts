/**
 * What waits on the wallet's transparent deposit addresses, by asset symbol:
 * the last check from this session (no network) and `check`, which asks the
 * nodes of every chain a flow has turned on. Only `check` contacts a node.
 */

import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { getActiveIbcSubnetworks } from '../config/networks';
import { useStore } from '../state';
import { keyRingSelector, selectEffectiveKeyInfo, selectEnabledNetworks } from '../state/keyring';
import { knownAssets } from '../transparent/assets';
import { readCheck, runCheck, type DepositAsset } from '../transparent/chain-check';

const CHAINS = (getActiveIbcSubnetworks('penumbra') as CosmosChainId[]).filter(
  c => COSMOS_CHAINS[c],
);

export interface Holding {
  chainId: CosmosChainId;
  /** the deposit address's hd index, for the shield and send flows */
  index: number;
  asset: DepositAsset;
}

export type HoldingsStatus = 'unchecked' | 'checking' | 'checked' | 'unanswered';

export const useTransparentHoldings = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  // only hot (mnemonic) wallets derive deposit addresses here
  const keyId = keyInfo?.type === 'mnemonic' ? keyInfo.id : undefined;
  const enabled = useStore(selectEnabledNetworks) as string[];
  const { getMnemonic } = useStore(keyRingSelector);
  const queryClient = useQueryClient();
  // a chain is here once a flow used it (receive's shield tab, a withdrawal)
  const chains = keyId ? CHAINS.filter(c => enabled.includes(c)) : [];

  // the same cache entries the send flow reads, so both see one check
  const reads = useQueries({
    queries: chains.map(c => ({
      queryKey: ['chainCheck', c, keyId],
      queryFn: () => (keyId ? readCheck(keyId, c) : null),
      staleTime: Infinity,
      structuralSharing: false, // bigint amounts
    })),
  });
  const run = useMutation({
    mutationFn: () =>
      Promise.all(
        chains.map(c =>
          runCheck(keyId!, c, () => getMnemonic(keyId!)).then(
            next => queryClient.setQueryData(['chainCheck', c, keyId], next),
            () => undefined, // a chain that fails keeps its last result
          ),
        ),
      ),
  });

  const holdings = new Map<string, Holding[]>();
  let at = 0;
  let missed = false;
  reads.forEach((r, i) => {
    const check = r.data;
    if (!check) {
      return;
    }
    at = Math.max(at, check.at);
    missed ||= check.missed > 0;
    for (const w of check.funded) {
      for (const asset of w.assets) {
        const key = asset.symbol.toLowerCase();
        holdings.set(key, [
          ...(holdings.get(key) ?? []),
          { chainId: chains[i]!, index: w.index, asset },
        ]);
      }
    }
  });

  const status: HoldingsStatus = run.isPending
    ? 'checking'
    : missed
      ? 'unanswered'
      : at
        ? 'checked'
        : 'unchecked';

  return {
    chains,
    /** symbols a deposit address on these chains can hold, lowercase */
    symbols: new Set(
      chains.flatMap(c => [...knownAssets(c).values()].map(a => a.symbol.toLowerCase())),
    ),
    holdings,
    status,
    at,
    check: () => {
      if (keyId && chains.length && !run.isPending) {
        run.mutate();
      }
    },
  };
};
