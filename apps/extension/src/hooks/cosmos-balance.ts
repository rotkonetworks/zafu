/**
 * cosmos balance hook
 *
 * fetches balance for cosmos chains using RPC.
 * transparent balance fetching is enabled per-user via settings-networks
 * when they explicitly toggle on a cosmos/IBC chain.
 */

import { useQuery } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, keyRingSelector } from '../state/keyring';
import {
  createSigningClient,
  deriveAllChainAddresses,
  deriveChainAddress,
  deriveCosmosWallet,
} from '@repo/wallet/networks/cosmos/signer';
import { getBalance, getAllBalances } from '@repo/wallet/networks/cosmos/client';
import {
  COSMOS_CHAINS,
  rpcEndpointPool,
  type CosmosChainId,
} from '@repo/wallet/networks/cosmos/chains';
import { getNobleRpcPool } from './noble-rpc';

/** hook to get balance for a specific cosmos chain */
export const useCosmosBalance = (chainId: CosmosChainId, accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);

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
    enabled:
      !!selectedKeyInfo &&
      (selectedKeyInfo.type === 'mnemonic' || selectedKeyInfo.type === 'zigner-zafu'),
    structuralSharing: false, // balance.amount is bigint — not JSON-serializable
    staleTime: 30_000, // 30 seconds
    refetchInterval: 60_000, // refetch every minute
  });
};

/** hook to get balances for all cosmos chains */
export const useAllCosmosBalances = (accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);

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

      // derive base address (noble) then convert to other chains
      const { address: nobleAddress } = await createSigningClient('noble', mnemonic, accountIndex);
      const addresses = deriveAllChainAddresses(nobleAddress);

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
        }),
      );

      return Object.fromEntries(results.map(r => [r.chainId, r])) as Record<
        CosmosChainId,
        (typeof results)[0]
      >;
    },
    enabled:
      !!selectedKeyInfo &&
      (selectedKeyInfo.type === 'mnemonic' || selectedKeyInfo.type === 'zigner-zafu'),
    structuralSharing: false, // balances contain bigint — not JSON-serializable
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
};

export interface DepositAsset {
  denom: string;
  symbol: string;
  amount: bigint;
  formatted: string;
}

export interface DepositWallet {
  index: number;
  address: string;
  /** total across all assets - drives the funded/unused split */
  balance: bigint;
  /** the native asset's formatted balance, kept for the compact summary line */
  formatted: string;
  /** every asset held at this burner (UM, USDC, ...) - each independently movable */
  assets: DepositAsset[];
}

const DEPOSIT_SCAN_GAP = 8;

/**
 * Scan burner deposit addresses (indices 0..gap) for one chain. Returns the
 * FUNDED ones (your deposit wallets, each independently shieldable) plus the
 * first UNUSED index (the fresh address to receive on).
 *
 * Stateless on purpose: the receive pointer and the funded set are derived from
 * on-chain balances, not a stored counter. That is what makes it safe - a
 * counter that advances past a funded address (which is what shipped earlier)
 * strands funds; deriving from balances can never lose sight of money.
 */
export const useCosmosDepositWallets = (chainId: CosmosChainId) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);

  return useQuery({
    queryKey: ['cosmosDepositWallets', chainId, selectedKeyInfo?.id],
    enabled: !!selectedKeyInfo && selectedKeyInfo.type === 'mnemonic',
    structuralSharing: false, // balances are bigint
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!selectedKeyInfo || selectedKeyInfo.type !== 'mnemonic') {
        return null;
      }
      const mnemonic = await getMnemonic(selectedKeyInfo.id);
      const config = COSMOS_CHAINS[chainId];
      // the user-editable pool for Noble; other chains use their config pool
      const pool = chainId === 'noble' ? await getNobleRpcPool() : rpcEndpointPool(chainId);

      const scan = await Promise.all(
        Array.from({ length: DEPOSIT_SCAN_GAP + 1 }, (_, i) => i).map(async index => {
          const { address: base } = await deriveCosmosWallet(mnemonic, index);
          const address = deriveChainAddress(base, chainId);
          // A burner can hold more than its native asset: an unshield lands UM
          // here, and the user may also route USDC into the same address before
          // burning it. Scan every balance, not just the native denom.
          //
          // Query each burner through a DIFFERENT RPC endpoint (rotated by index)
          // so no single provider sees all of your deposit addresses together.
          // If that endpoint is down, fall back to the primary rather than hide
          // a funded burner.
          const toAssets = (balances: { denom: string; amount: bigint }[]): DepositAsset[] =>
            balances
              .filter(b => b.amount > 0n)
              .map(b => {
                const isNative = b.denom === config.denom;
                const symbol = isNative ? config.symbol : denomToSymbol(b.denom);
                const decimals = isNative ? config.decimals : 6;
                return {
                  denom: b.denom,
                  symbol,
                  amount: b.amount,
                  formatted: formatBalance(b.amount, decimals, symbol),
                };
              })
              .sort((a, b) => Number(b.amount - a.amount));

          let assets: DepositAsset[] = [];
          const endpoint = pool[index % pool.length];
          try {
            assets = toAssets(await getAllBalances(chainId, address, endpoint));
          } catch {
            try {
              assets = toAssets(await getAllBalances(chainId, address));
            } catch {
              /* both unreachable this pass -> empty, retried on refetch */
            }
          }
          const total = assets.reduce((sum, a) => sum + a.amount, 0n);
          const native = assets.find(a => a.denom === config.denom);
          return {
            index,
            address,
            balance: total,
            formatted: native?.formatted ?? formatBalance(0n, config.decimals, config.symbol),
            assets,
          } as DepositWallet;
        }),
      );

      const funded = scan.filter(w => w.balance > 0n);
      const receive = scan.find(w => w.balance === 0n) ?? scan[scan.length - 1];
      // `used` = every address up to (not including) the fresh receive pointer:
      // funded now, or funded before and since drained. The Receive tab lists
      // these so a user can see/return to any address they've deposited to.
      const used = receive ? scan.filter(w => w.index < receive.index) : [];
      return { funded, receive, used, all: scan };
    },
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
function getZignerCosmosAddress(
  keyInfo: { insensitive: Record<string, unknown> },
  chainId: CosmosChainId,
): string | null {
  const addrs = keyInfo.insensitive['cosmosAddresses'] as
    | { chainId: string; address: string; prefix: string }[]
    | undefined;
  if (!addrs) {
    return null;
  }
  const match = addrs.find(a => a.chainId === chainId);
  if (match) {
    return match.address;
  }
  // try to derive from any stored address using bech32 prefix swap
  if (addrs.length > 0) {
    try {
      return deriveChainAddress(addrs[0]!.address, chainId);
    } catch {
      return null;
    }
  }
  return null;
}

/** find a keyInfo with cosmos capability — effective first, then any wallet that has cosmos addresses */
function findCosmosCapableKey(
  keyInfos: { id: string; type: string; insensitive: Record<string, unknown> }[],
  effective: { id: string; type: string; insensitive: Record<string, unknown> } | undefined,
  chainId: CosmosChainId,
): { id: string; type: string; insensitive: Record<string, unknown> } | null {
  // try effective first
  if (effective) {
    if (effective.type === 'mnemonic') {
      return effective;
    }
    if (effective.type === 'zigner-zafu' && getZignerCosmosAddress(effective, chainId)) {
      return effective;
    }
  }
  // fallback: search all keyInfos for one with cosmos capability
  for (const ki of keyInfos) {
    if (ki === effective) {
      continue;
    }
    if (ki.type === 'mnemonic') {
      return ki;
    }
    if (ki.type === 'zigner-zafu' && getZignerCosmosAddress(ki, chainId)) {
      return ki;
    }
  }
  return null;
}

/** hook to get all assets (native + IBC tokens) for a cosmos chain */
export const useCosmosAssets = (chainId: CosmosChainId, accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const allKeyInfos = useStore(state => state.keyRing.keyInfos);
  const { getMnemonic } = useStore(keyRingSelector);

  // find a wallet with cosmos capability (may differ from effective when active network is penumbra)
  const cosmosKey = findCosmosCapableKey(allKeyInfos, selectedKeyInfo, chainId);

  return useQuery({
    queryKey: ['cosmosAssets', chainId, cosmosKey?.id ?? null, accountIndex],
    queryFn: async () => {
      if (!cosmosKey) {
        return null;
      }

      let address: string;

      if (cosmosKey.type === 'zigner-zafu') {
        const storedAddr = getZignerCosmosAddress(cosmosKey, chainId);
        if (!storedAddr) {
          return null;
        }
        address = storedAddr;
      } else if (cosmosKey.type === 'mnemonic') {
        const mnemonic = await getMnemonic(cosmosKey.id);
        const client = await createSigningClient(chainId, mnemonic, accountIndex);
        address = client.address;
      } else {
        return null;
      }

      const config = COSMOS_CHAINS[chainId];
      const balances = await getAllBalances(chainId, address);

      const assets: CosmosAsset[] = balances
        .filter(b => b.amount > 0n)
        .map(b => {
          const isNative = b.denom === config.denom;
          const symbol = isNative ? config.symbol : denomToSymbol(b.denom);
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
        .sort((a, b) => {
          if (a.isNative && !b.isNative) {
            return -1;
          }
          if (!a.isNative && b.isNative) {
            return 1;
          }
          return Number(b.amount - a.amount);
        });

      return {
        address,
        assets,
        nativeAsset: assets.find(a => a.isNative) ?? null,
      };
    },
    enabled: !!cosmosKey,
    structuralSharing: false, // CosmosAsset.amount is bigint — not JSON-serializable
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
};

/**
 * Known IBC denoms -> display symbol. IBC denoms are opaque hashes; without a
 * denom-trace lookup we can't resolve them, so map the ones we ship. This is
 * Penumbra's UM as it lands on Noble after an IBC transfer.
 */
const KNOWN_IBC_DENOMS: Record<string, string> = {
  'ibc/955A03D0BC92B11738A1E4B0C9F2AAF05B79929703F907D2D7AF5A0D405AE8C1': 'UM',
};

/** derive display symbol from denom */
function denomToSymbol(denom: string): string {
  // native denoms like 'uosmo' -> 'OSMO'
  if (denom.startsWith('u')) {
    return denom.slice(1).toUpperCase();
  }
  // IBC denoms like 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2'
  if (denom.startsWith('ibc/')) {
    // resolve known ones to their symbol; otherwise truncate the hash
    return KNOWN_IBC_DENOMS[denom] ?? `IBC/${denom.slice(4, 10)}`;
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
