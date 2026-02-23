/**
 * cosmos balance hook
 *
 * fetches balance for cosmos chains using RPC.
 *
 * cosmos chains are inherently transparent — selecting one means the user
 * consented to public RPC queries. no additional privacy gate needed.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, keyRingSelector } from '../state/keyring';
import { createSigningClient, deriveAllChainAddresses, deriveChainAddress } from '@repo/wallet/networks/cosmos/signer';
import { getBalance, getAllBalances } from '@repo/wallet/networks/cosmos/client';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

/** auto-enable transparent balance fetching when using cosmos hooks */
function useAutoEnableTransparent() {
  const enabled = useStore(state => state.privacy.settings.enableTransparentBalances);
  const setSetting = useStore(state => state.privacy.setSetting);
  useEffect(() => {
    if (!enabled) {
      void setSetting('enableTransparentBalances', true);
    }
  }, [enabled, setSetting]);
}

/** hook to get balance for a specific cosmos chain */
export const useCosmosBalance = (chainId: CosmosChainId, accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);
  useAutoEnableTransparent();

  return useQuery({
    queryKey: ['cosmosBalance', chainId, selectedKeyInfo?.id, accountIndex],
    queryFn: async () => {
      if (!selectedKeyInfo) {
        throw new Error('no wallet selected');
      }
      if (selectedKeyInfo.type !== 'mnemonic') {
        return null;
      }

      const mnemonic = await getMnemonic(selectedKeyInfo.id);
      const { address } = await createSigningClient(chainId, mnemonic, accountIndex);

      const balance = await getBalance(chainId, address);
      const config = COSMOS_CHAINS[chainId];

      return {
        address,
        balance: balance.amount,
        denom: balance.denom,
        decimals: config.decimals,
        symbol: config.symbol,
        formatted: formatBalance(balance.amount, config.decimals, config.symbol),
      };
    },
    enabled: !!selectedKeyInfo && (selectedKeyInfo.type === 'mnemonic' || selectedKeyInfo.type === 'zigner-zafu'),
    staleTime: 30_000, // 30 seconds
    refetchInterval: 60_000, // refetch every minute
  });
};

/** hook to get balances for all cosmos chains */
export const useAllCosmosBalances = (accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);
  useAutoEnableTransparent();

  return useQuery({
    queryKey: ['allCosmosBalances', selectedKeyInfo?.id, accountIndex],
    queryFn: async () => {
      if (!selectedKeyInfo) {
        throw new Error('no wallet selected');
      }
      if (selectedKeyInfo.type !== 'mnemonic') {
        return null;
      }

      const mnemonic = await getMnemonic(selectedKeyInfo.id);

      // derive base address (osmosis) then convert to other chains
      const { address: osmoAddress } = await createSigningClient('osmosis', mnemonic, accountIndex);
      const addresses = deriveAllChainAddresses(osmoAddress);

      // fetch all balances in parallel
      const results = await Promise.all(
        Object.entries(COSMOS_CHAINS).map(async ([chainId, config]) => {
          try {
            const address = addresses[chainId as CosmosChainId];
            const balance = await getBalance(chainId as CosmosChainId, address);
            return {
              chainId: chainId as CosmosChainId,
              address,
              balance: balance.amount,
              denom: balance.denom,
              decimals: config.decimals,
              symbol: config.symbol,
              formatted: formatBalance(balance.amount, config.decimals, config.symbol),
            };
          } catch (err) {
            console.warn(`failed to fetch ${chainId} balance:`, err);
            return {
              chainId: chainId as CosmosChainId,
              address: addresses[chainId as CosmosChainId],
              balance: 0n,
              denom: config.denom,
              decimals: config.decimals,
              symbol: config.symbol,
              formatted: `0 ${config.symbol}`,
              error: true,
            };
          }
        })
      );

      return Object.fromEntries(results.map(r => [r.chainId, r])) as Record<
        CosmosChainId,
        (typeof results)[0]
      >;
    },
    enabled: !!selectedKeyInfo && (selectedKeyInfo.type === 'mnemonic' || selectedKeyInfo.type === 'zigner-zafu'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
};

/** asset info for UI display */
export interface CosmosAsset {
  denom: string;
  amount: bigint;
  /** display symbol (derived from denom) */
  symbol: string;
  /** decimals (6 for most cosmos assets) */
  decimals: number;
  /** formatted balance string */
  formatted: string;
  /** whether this is the native chain token */
  isNative: boolean;
}

/** get cosmos address from zigner vault insensitive data */
function getZignerCosmosAddress(keyInfo: { insensitive: Record<string, unknown> }, chainId: CosmosChainId): string | null {
  const addrs = keyInfo.insensitive['cosmosAddresses'] as
    { chainId: string; address: string; prefix: string }[] | undefined;
  if (!addrs) return null;
  const match = addrs.find(a => a.chainId === chainId);
  if (match) return match.address;
  // try to derive from any stored address using bech32 prefix swap
  if (addrs.length > 0) {
    try {
      return deriveChainAddress(addrs[0]!.address, chainId);
    } catch { return null; }
  }
  return null;
}

/** hook to get all assets (native + IBC tokens) for a cosmos chain */
export const useCosmosAssets = (chainId: CosmosChainId, accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);
  useAutoEnableTransparent();

  return useQuery({
    queryKey: ['cosmosAssets', chainId, selectedKeyInfo?.id, accountIndex],
    queryFn: async () => {
      if (!selectedKeyInfo) {
        throw new Error('no wallet selected');
      }

      let address: string;

      if (selectedKeyInfo.type === 'zigner-zafu') {
        // zigner wallet - get address from stored insensitive data
        const storedAddr = getZignerCosmosAddress(selectedKeyInfo, chainId);
        if (!storedAddr) return null;
        address = storedAddr;
      } else if (selectedKeyInfo.type === 'mnemonic') {
        const mnemonic = await getMnemonic(selectedKeyInfo.id);
        const client = await createSigningClient(chainId, mnemonic, accountIndex);
        address = client.address;
      } else {
        return null;
      }

      const config = COSMOS_CHAINS[chainId];

      const balances = await getAllBalances(chainId, address);

      // map balances to asset info
      const assets: CosmosAsset[] = balances
        .filter(b => b.amount > 0n)
        .map(b => {
          const isNative = b.denom === config.denom;
          // derive symbol from denom
          const symbol = isNative
            ? config.symbol
            : denomToSymbol(b.denom);
          // assume 6 decimals for most cosmos assets
          const decimals = isNative ? config.decimals : 6;

          return {
            denom: b.denom,
            amount: b.amount,
            symbol,
            decimals,
            formatted: formatBalance(b.amount, decimals, symbol),
            isNative,
          };
        })
        // sort: native first, then by amount
        .sort((a, b) => {
          if (a.isNative && !b.isNative) return -1;
          if (!a.isNative && b.isNative) return 1;
          return Number(b.amount - a.amount);
        });

      return {
        address,
        assets,
        nativeAsset: assets.find(a => a.isNative) ?? null,
      };
    },
    enabled: !!selectedKeyInfo && (selectedKeyInfo.type === 'mnemonic' || selectedKeyInfo.type === 'zigner-zafu'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
};

/** derive display symbol from denom */
function denomToSymbol(denom: string): string {
  // native denoms like 'uosmo' -> 'OSMO'
  if (denom.startsWith('u')) {
    return denom.slice(1).toUpperCase();
  }
  // IBC denoms like 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2'
  if (denom.startsWith('ibc/')) {
    // truncate hash for display
    return `IBC/${denom.slice(4, 10)}`;
  }
  // factory denoms
  if (denom.startsWith('factory/')) {
    const parts = denom.split('/');
    return parts[parts.length - 1]?.toUpperCase() ?? denom;
  }
  return denom.toUpperCase();
}

/** format balance with decimals */
function formatBalance(amount: bigint, decimals: number, symbol: string): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const fractional = amount % divisor;

  if (fractional === 0n) {
    return `${whole} ${symbol}`;
  }

  const fractionalStr = fractional.toString().padStart(decimals, '0');
  // trim trailing zeros
  const trimmed = fractionalStr.replace(/0+$/, '');
  // limit to 6 decimal places for display
  const display = trimmed.slice(0, 6);

  return `${whole}.${display} ${symbol}`;
}
