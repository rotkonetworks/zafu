/** balances on the transparent chains under Penumbra (Noble, Injective, ...) */

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from '../state';
import {
  selectEffectiveKeyInfo,
  keyRingSelector,
  selectActiveNetwork,
  type NetworkType,
} from '../state/keyring';
import { refreshEgress } from '../net/egress';
import { getRootNetwork } from '../config/networks';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { conduitFor } from '@repo/wallet/networks/transparent/conduit';
import { knownAssets } from '../transparent/assets';
import { cosmosKeyFor } from '../signing/cosmos-key';
import { localExtStorage } from '@repo/storage-chrome/local';
import {
  checkState,
  deriveAddresses,
  formatBalance,
  readCheck,
  runCheck,
} from '../transparent/chain-check';

/**
 * Cosmos chains (Noble, Injective, ...) are penumbra BURNERS - transparent
 * sub-accounts that only exist to shield into / withdraw out of penumbra. Their
 * balance reads are gated on the user being ACTIVELY on penumbra (its root),
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

const noop = () => undefined;

/** wallet + chain the burner checks are keyed by; only hot wallets derive burners here */
const useCheckKey = (chainId: CosmosChainId) => {
  const keyInfo = useStore(selectEffectiveKeyInfo);
  return keyInfo?.type === 'mnemonic' ? ['chainCheck', chainId, keyInfo.id] : undefined;
};

/**
 * One transparent chain's burner balances: the last check from the session
 * (no network) and `check` to ask the chain again. Only `check` - a user
 * action - ever contacts the chain's nodes.
 */
export const useChainCheck = (chainId: CosmosChainId) => {
  const queryKey = useCheckKey(chainId);
  const keyId = queryKey?.[2];
  const { getMnemonic } = useStore(keyRingSelector);
  const toggleNetwork = useStore(s => s.keyRing.toggleNetwork);
  const setPrivacy = useStore(s => s.privacy.setSetting);
  const enabled = useStore(s => (s.keyRing.enabledNetworks as string[]).includes(chainId));
  const queryClient = useQueryClient();
  const { data: check } = useQuery({
    queryKey: queryKey ?? ['chainCheck', chainId],
    queryFn: () => (keyId ? readCheck(keyId, chainId) : null),
    enabled: !!keyId,
    staleTime: Infinity,
    structuralSharing: false, // bigint amounts
  });
  const run = useMutation({
    mutationKey: queryKey,
    mutationFn: () => runCheck(keyId!, chainId, () => getMnemonic(keyId!)),
    onSuccess: next => queryClient.setQueryData(queryKey!, next),
  });
  // an undefined key would match every mutation in the app
  const checking = useIsMutating({ mutationKey: queryKey ?? ['chainCheck', chainId, null] }) > 0;
  // a phrase or storage failure leaves the last result standing; nodes that
  // don't answer are counted inside the check itself
  const ask = () => (keyId ? run.mutateAsync().then(noop, noop) : Promise.resolve());
  return {
    state: checkState({ enabled, checking, check }),
    check: () => (enabled ? ask() : Promise.resolve()),
    /** the chain's nodes are allowed only while it is on: turn it on, then check */
    turnOn: async () => {
      await toggleNetwork(chainId as NetworkType);
      // the privacy summary lists cosmos balances as on from here
      await setPrivacy('enableTransparentBalances', true);
      await refreshEgress();
      await ask();
    },
  };
};

/** chains the user hid from the penumbra home (a backed-up setting), and the switch */
export const useHiddenChains = () => {
  const queryClient = useQueryClient();
  const { data: hidden = [] } = useQuery({
    queryKey: ['hiddenTransparentChains'],
    queryFn: async () => (await localExtStorage.get('hiddenTransparentChains')) ?? [],
  });
  const setHidden = async (chainId: CosmosChainId, hide: boolean) => {
    const next = hide ? [...new Set([...hidden, chainId])] : hidden.filter(c => c !== chainId);
    queryClient.setQueryData(['hiddenTransparentChains'], next);
    await localExtStorage.set('hiddenTransparentChains', next);
  };
  return { hidden, setHidden };
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

/** hook to get all assets (native + IBC tokens) for a cosmos chain */
export const useCosmosAssets = (chainId: CosmosChainId, accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);

  // the selected wallet's own key only; another wallet's balance is never shown
  const cosmosKey = cosmosKeyFor(selectedKeyInfo, chainId);
  const burnerEnabled = useBurnerPollingEnabled();

  return useQuery({
    queryKey: ['cosmosAssets', chainId, cosmosKey?.key.id ?? null, accountIndex],
    queryFn: async () => {
      if (!cosmosKey) {
        return null;
      }
      const address =
        cosmosKey.signer === 'zigner'
          ? cosmosKey.address
          : (
              await deriveAddresses(cosmosKey.key.id, chainId, [accountIndex], () =>
                getMnemonic(cosmosKey.key.id),
              )
            ).get(accountIndex)!;

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
    structuralSharing: false, // CosmosAsset.amount is bigint - not JSON-serializable
    staleTime: 30_000,
  });
};
