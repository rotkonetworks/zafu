/**
 * cosmos balance hook
 *
 * fetches balance for cosmos chains using RPC.
 * transparent balance fetching is enabled per-user via settings-networks
 * when they explicitly toggle on a cosmos/IBC chain.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, keyRingSelector, selectActiveNetwork } from '../state/keyring';
import { getRootNetwork } from '../config/networks';
import { deriveChainAddress } from '@repo/wallet/networks/cosmos/signer';
import {
  COSMOS_CHAINS,
  rpcEndpointPool,
  type CosmosChainId,
} from '@repo/wallet/networks/cosmos/chains';
import { getNobleRpcPool } from './noble-rpc';
import { getInjectiveRpcPool } from './injective-rpc';
import { shortSymbol } from '../utils/asset-display';
import { conduitFor } from '@repo/wallet/networks/transparent/conduit';
import { peekHdIndex } from '@repo/storage-chrome/cosmos-chain-counters';
import { knownAssets } from '../transparent/assets';
import {
  readFundedIndices,
  readShownIndices,
  rememberFundedIndices,
  scanIndices,
} from '../transparent/hd';

/**
 * Cosmos chains (Noble, Injective, ...) are penumbra BURNERS - transparent
 * sub-accounts that only exist to shield into / withdraw out of penumbra. Their
 * balance polling is gated on the user being ACTIVELY on penumbra (its root),
 * not merely having it enabled: full network isolation means a wallet viewing
 * zcash touches NO noble-rpc / injective RPC at all. A cosmos subnetwork (Noble)
 * roots to penumbra, so viewing a burner still counts as on-penumbra.
 */
const useBurnerPollingEnabled = (): boolean => {
  const activeNetwork = useStore(selectActiveNetwork);
  if (!activeNetwork || getRootNetwork(activeNetwork) !== 'penumbra') {
    return false;
  }
  return true;
};

export interface DepositAsset {
  denom: string;
  symbol: string;
  amount: bigint;
  /** undefined for a denom we can't identify (shown in base units) */
  decimals?: number;
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

/**
 * Derived addresses per vault, chain and index. Each derivation stretches the
 * seed, so a poll only derives indices it has not seen.
 */
const addressCache = new Map<string, string>();
const deriveCached = async (
  keyId: string,
  chainId: CosmosChainId,
  mnemonic: string,
  index: number,
): Promise<string> => {
  const k = `${keyId}:${chainId}:${index}`;
  let address = addressCache.get(k);
  if (!address) {
    address = await conduitFor(chainId).deriveAddress(mnemonic, index);
    addressCache.set(k, address);
  }
  return address;
};

/**
 * Balances -> display assets. Known assets carry their real decimals (INJ is
 * 18, USDC 6); an unknown denom is still listed, in raw base units, so no
 * funds ever disappear from view.
 */
const toDepositAssets = (
  chainId: CosmosChainId,
  balances: readonly { denom: string; amount: bigint }[],
): DepositAsset[] => {
  const known = knownAssets(chainId);
  return balances
    .filter(b => b.amount > 0n)
    .map(b => {
      const meta = known.get(b.denom.toLowerCase());
      const symbol = meta?.symbol ?? denomToSymbol(b.denom);
      return {
        denom: b.denom,
        symbol,
        amount: b.amount,
        decimals: meta?.decimals,
        formatted: meta
          ? formatBalance(b.amount, meta.decimals, symbol)
          : `${b.amount} ${symbol} (base units)`,
      };
    })
    .sort((a, b) => Number(b.amount - a.amount));
};

/**
 * Scan a transparent chain's deposit addresses: 0..8 (where the old
 * first-empty model put them), the most recently handed-out indices, and
 * every index that ever held funds. Returns the FUNDED ones (each
 * independently shieldable / sendable) plus the first scanned empty address.
 *
 * Derivation and balances go through the chain's conduit, so Injective stays
 * on coin type 60 and its LCD.
 */
export const useCosmosDepositWallets = (chainId: CosmosChainId) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);
  const burnerEnabled = useBurnerPollingEnabled();
  useColdSweep(chainId, burnerEnabled);

  return useQuery({
    queryKey: ['cosmosDepositWallets', chainId, selectedKeyInfo?.id],
    enabled: burnerEnabled && !!selectedKeyInfo && selectedKeyInfo.type === 'mnemonic',
    structuralSharing: false, // balances are bigint
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!selectedKeyInfo || selectedKeyInfo.type !== 'mnemonic') {
        return null;
      }
      const keyId = selectedKeyInfo.id;
      const mnemonic = await getMnemonic(keyId);
      const conduit = conduitFor(chainId);
      // user-editable pools for Noble + Injective (Settings -> Penumbra ->
      // burners); other chains use their config pool
      const pool =
        chainId === 'noble'
          ? await getNobleRpcPool()
          : chainId === 'injective'
            ? await getInjectiveRpcPool()
            : rpcEndpointPool(chainId);

      const [highest, rememberedFunded] = await Promise.all([
        peekHdIndex(chainId),
        readFundedIndices(chainId, keyId),
      ]);
      const indices = scanIndices(highest, rememberedFunded);

      // An unreachable endpoint must not read as an empty burner (funds look
      // gone): surfaced to the UI as a "balance may be stale" note.
      let rpcError = false;

      // derive first (CPU, cached), then query every address in parallel
      const targets: { index: number; address: string }[] = [];
      for (const index of indices) {
        targets.push({ index, address: await deriveCached(keyId, chainId, mnemonic, index) });
      }
      const config = COSMOS_CHAINS[chainId];
      const scan = await Promise.all(
        targets.map(async ({ index, address }): Promise<DepositWallet> => {
          // Each burner through a DIFFERENT endpoint (rotated by index) so no
          // single provider sees all of your deposit addresses together; on
          // failure fall back to the primary rather than hide a funded burner.
          let balances: { denom: string; amount: bigint }[] = [];
          try {
            balances = await conduit.queryBalances(address, pool[index % pool.length]);
          } catch {
            try {
              balances = await conduit.queryBalances(address);
            } catch {
              rpcError = true; // retried on refetch
            }
          }
          const assets = toDepositAssets(chainId, balances);
          const native = assets.find(a => a.denom === config.denom);
          return {
            index,
            address,
            balance: assets.reduce((sum, x) => sum + x.amount, 0n),
            formatted: native?.formatted ?? formatBalance(0n, config.decimals, config.symbol),
            assets,
          };
        }),
      );

      const funded = scan.filter(w => w.balance > 0n);
      if (funded.some(w => !rememberedFunded.includes(w.index))) {
        await rememberFundedIndices(
          chainId,
          keyId,
          funded.map(w => w.index),
        );
      }
      const receive = scan.find(w => w.balance === 0n) ?? scan[scan.length - 1];
      // `used` = every scanned address below the receive pointer: funded now,
      // or funded before and since drained.
      const used = receive ? scan.filter(w => w.index < receive.index) : [];
      return { funded, receive, used, all: scan, rpcError };
    },
  });
};

/** cadence of the slow sweep over every address ever shown */
const COLD_SWEEP_MS = 180_000;

/**
 * Every address ever shown as a receive address stays watched: an exchange
 * often keeps paying a whitelisted address long after we rotated past it.
 * Shown indices outside the regular scan are checked one at a time every few
 * minutes; any holding funds join the funded set, which the 30s scan covers.
 */
const useColdSweep = (chainId: CosmosChainId, enabled: boolean) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['cosmosColdSweep', chainId, selectedKeyInfo?.id],
    enabled: enabled && selectedKeyInfo?.type === 'mnemonic',
    staleTime: COLD_SWEEP_MS - 10_000,
    refetchInterval: COLD_SWEEP_MS,
    queryFn: async (): Promise<number[]> => {
      if (selectedKeyInfo?.type !== 'mnemonic') {
        return [];
      }
      const keyId = selectedKeyInfo.id;
      const [shown, funded, highest] = await Promise.all([
        readShownIndices(chainId, keyId),
        readFundedIndices(chainId, keyId),
        peekHdIndex(chainId),
      ]);
      const hot = new Set(scanIndices(highest, funded));
      const cold = shown.filter(i => !hot.has(i));
      if (cold.length === 0) {
        return [];
      }
      const mnemonic = await getMnemonic(keyId);
      const conduit = conduitFor(chainId);
      const found: number[] = [];
      for (const index of cold) {
        const address = await deriveCached(keyId, chainId, mnemonic, index);
        try {
          if ((await conduit.queryBalances(address)).some(b => b.amount > 0n)) {
            found.push(index);
          }
        } catch {
          // endpoint hiccup: the next sweep retries this index
        }
        // one at a time, yielding: this is a background chore
        await new Promise<void>(resolve => {
          setTimeout(resolve, 50);
        });
      }
      if (found.length) {
        await rememberFundedIndices(chainId, keyId, found);
        void queryClient.invalidateQueries({ queryKey: ['cosmosDepositWallets', chainId] });
      }
      return found;
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
  // zigner holds coin-118 cosmos keys; any address it has for an Ethermint
  // chain would be the wrong one
  if (COSMOS_CHAINS[chainId].keyAlgo === 'eth_secp256k1') {
    return null;
  }
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
  const burnerEnabled = useBurnerPollingEnabled();

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
        address = await deriveCached(cosmosKey.id, chainId, mnemonic, accountIndex);
      } else {
        return null;
      }

      const config = COSMOS_CHAINS[chainId];
      const balances = await conduitFor(chainId).queryBalances(address);
      const known = knownAssets(chainId);

      // Only assets we know the decimals of: this list feeds the send form, and
      // a guessed exponent sends the wrong amount (INJ is 18, not 6).
      const assets: CosmosAsset[] = balances
        .filter(b => b.amount > 0n && known.has(b.denom.toLowerCase()))
        .map(b => {
          const meta = known.get(b.denom.toLowerCase())!;
          const isNative = b.denom.toLowerCase() === config.denom.toLowerCase();
          const symbol = meta.symbol;
          const decimals = meta.decimals;
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
    enabled: burnerEnabled && !!cosmosKey,
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

/**
 * derive a display symbol from a raw cosmos denom.
 *
 * This is only the last-resort fallback for the raw balance data - the receive
 * UI resolves proper registry symbols + icons at render via useRegistryAssetMetadata.
 * We keep a couple of hardcoded IBC hashes we ship, then defer to the shared
 * sanitizer so we never surface a raw path or full hash to the user.
 */
function denomToSymbol(denom: string): string {
  return KNOWN_IBC_DENOMS[denom] ?? shortSymbol(denom);
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
