/**
 * User-editable RPC endpoint pool for each transparent (cosmos) chain.
 * Balance and deposit-address lookups rotate across the pool per address, so
 * no single provider can link all of a user's addresses. Edited in Settings ->
 * networks -> Penumbra -> transparent chains; persisted in chrome.storage.local
 * and falling back to the chain config's pool when unset or empty.
 *
 * Signing and broadcast still go through the chain's single `rpcEndpoint`.
 */

import { useEffect, useState } from 'react';
import { rpcEndpointPool, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

/** storage key per chain; noble + injective keep the keys they shipped with */
const keyFor = (chainId: CosmosChainId): string =>
  chainId === 'injective'
    ? 'injectiveRpcPool'
    : chainId === 'noble'
      ? 'nobleRpcEndpoints'
      : `${chainId}RpcEndpoints`;

const clean = (list: string[]): string[] => list.map(u => u.trim()).filter(Boolean);

const readCustom = async (chainId: CosmosChainId): Promise<string[]> => {
  const key = keyFor(chainId);
  const stored = (await chrome.storage.local.get(key))[key] as string[] | undefined;
  return stored ? clean(stored) : [];
};

/** the shipped default pool (from chain config) */
export const defaultRpcPool = (chainId: CosmosChainId): string[] => rpcEndpointPool(chainId);

/** effective pool: the user's stored list if any, else the shipped default */
export const getRpcPool = async (chainId: CosmosChainId): Promise<string[]> => {
  const custom = await readCustom(chainId);
  return custom.length ? custom : defaultRpcPool(chainId);
};

/** persist the pool; an empty list clears the override (reverts to default) */
export const setRpcPool = async (chainId: CosmosChainId, endpoints: string[]): Promise<void> => {
  await chrome.storage.local.set({ [keyFor(chainId)]: clean(endpoints) });
};

/** react hook: the effective pool + a setter, kept in sync with storage */
export const useRpcPool = (
  chainId: CosmosChainId,
): {
  pool: string[];
  isCustom: boolean;
  save: (endpoints: string[]) => Promise<void>;
  reset: () => Promise<void>;
} => {
  const [pool, setPool] = useState<string[]>(() => defaultRpcPool(chainId));
  const [isCustom, setIsCustom] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const custom = await readCustom(chainId);
      if (alive) {
        setIsCustom(custom.length > 0);
        setPool(custom.length ? custom : defaultRpcPool(chainId));
      }
    };
    void load();
    const key = keyFor(chainId);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[key]) {
        void load();
      }
    };
    chrome.storage.local.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.local.onChanged.removeListener(onChanged);
    };
  }, [chainId]);

  return {
    pool,
    isCustom,
    save: (endpoints: string[]) => setRpcPool(chainId, endpoints),
    reset: () => setRpcPool(chainId, []),
  };
};
