/**
 * What waits on the wallet's transparent deposit addresses, by asset symbol:
 * the last check from this session (no network), and `check(chain)`, which
 * asks that one chain's nodes and no other's. Only `check` contacts a node.
 */

import { useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { getActiveIbcSubnetworks } from '../config/networks';
import { useStore } from '../state';
import { keyRingSelector, selectEffectiveKeyInfo, selectEnabledNetworks } from '../state/keyring';
import { knownAssets } from '../transparent/assets';
import { readCheck, runCheck, type DepositAsset } from '../transparent/chain-check';

const CHAINS = getActiveIbcSubnetworks('penumbra').filter(c => COSMOS_CHAINS[c]);

export interface Holding {
  chainId: CosmosChainId;
  /** the deposit address's hd index, for the shield and send flows */
  index: number;
  asset: DepositAsset;
}

export type HoldingsStatus = 'unchecked' | 'checking' | 'checked' | 'unanswered';

export interface ChainStatus {
  status: HoldingsStatus;
  /** when its last check finished, epoch ms; 0 before any */
  at: number;
}

export const useTransparentHoldings = () => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  // only hot (mnemonic) wallets derive deposit addresses here
  const keyId = keyInfo?.type === 'mnemonic' ? keyInfo.id : undefined;
  const enabled = useStore(selectEnabledNetworks);
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
  const [checking, setChecking] = useState<ReadonlySet<CosmosChainId>>(new Set());
  const mark = (c: CosmosChainId, on: boolean) =>
    setChecking(prev => {
      const next = new Set(prev);
      if (on) {
        next.add(c);
      } else {
        next.delete(c);
      }
      return next;
    });

  const holdings = new Map<string, Holding[]>();
  const byChain = new Map<CosmosChainId, ChainStatus>();
  reads.forEach((r, i) => {
    const chainId = chains[i]!;
    const check = r.data;
    byChain.set(chainId, {
      status: checking.has(chainId)
        ? 'checking'
        : !check
          ? 'unchecked'
          : check.missed > 0
            ? 'unanswered'
            : 'checked',
      at: check?.at ?? 0,
    });
    for (const w of check?.funded ?? []) {
      for (const asset of w.assets) {
        const key = asset.symbol.toLowerCase();
        holdings.set(key, [...(holdings.get(key) ?? []), { chainId, index: w.index, asset }]);
      }
    }
  });

  /** ask one chain's nodes, and only that chain's */
  const check = (chainId: CosmosChainId) => {
    if (!keyId || !chains.includes(chainId) || checking.has(chainId)) {
      return;
    }
    mark(chainId, true);
    void runCheck(keyId, chainId, () => getMnemonic(keyId))
      .then(
        next => queryClient.setQueryData(['chainCheck', chainId, keyId], next),
        () => undefined, // a chain that fails keeps its last result
      )
      .finally(() => mark(chainId, false));
  };

  return {
    chains,
    /** chains whose deposit addresses can hold this asset symbol (lowercase) */
    chainsFor: (symbol: string) =>
      chains.filter(c => [...knownAssets(c).values()].some(a => a.symbol.toLowerCase() === symbol)),
    holdings,
    statusOf: (c: CosmosChainId): ChainStatus => byChain.get(c) ?? { status: 'unchecked', at: 0 },
    check,
  };
};
