/**
 * User-editable Noble RPC endpoint pool. Deposit-address lookups rotate across
 * this pool (per address) for privacy; the user can add/remove/edit the list in
 * Settings -> networks -> Penumbra -> Noble. Persisted in chrome.storage.local,
 * falling back to the shipped default pool when unset/empty.
 */

import { useEffect, useState } from 'react';
import { rpcEndpointPool } from '@repo/wallet/networks/cosmos/chains';

const KEY = 'nobleRpcEndpoints';

const clean = (list: string[]): string[] => list.map(u => u.trim()).filter(Boolean);

/** the shipped default pool (from chain config) */
export const defaultNobleRpcPool = (): string[] => rpcEndpointPool('noble');

/** effective pool: user's stored list if any, else the shipped default */
export const getNobleRpcPool = async (): Promise<string[]> => {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as string[] | undefined;
  const pool = stored ? clean(stored) : [];
  return pool.length ? pool : defaultNobleRpcPool();
};

/** persist the pool; an empty list clears the override (reverts to default) */
export const setNobleRpcPool = async (endpoints: string[]): Promise<void> => {
  await chrome.storage.local.set({ [KEY]: clean(endpoints) });
};

/** react hook: the effective pool + a setter, kept in sync with storage */
export const useNobleRpcPool = (): {
  pool: string[];
  isCustom: boolean;
  save: (endpoints: string[]) => Promise<void>;
  reset: () => Promise<void>;
} => {
  const [pool, setPool] = useState<string[]>(defaultNobleRpcPool());
  const [isCustom, setIsCustom] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const stored = (await chrome.storage.local.get(KEY))[KEY] as string[] | undefined;
      const custom = stored ? clean(stored) : [];
      if (alive) {
        setIsCustom(custom.length > 0);
        setPool(custom.length ? custom : defaultNobleRpcPool());
      }
    };
    void load();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[KEY]) {
        void load();
      }
    };
    chrome.storage.local.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.local.onChanged.removeListener(onChanged);
    };
  }, []);

  return {
    pool,
    isCustom,
    save: (endpoints: string[]) => setNobleRpcPool(endpoints),
    reset: () => setNobleRpcPool([]),
  };
};
