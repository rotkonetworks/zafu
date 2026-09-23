/**
 * User-editable Injective RPC endpoint pool. Deposit-address lookups rotate
 * across this pool (per burner index) for privacy; the user can add/remove/edit
 * the list in Settings -> networks -> Penumbra -> Injective. Persisted in
 * chrome.storage.local under `injectiveRpcPool`, falling back to a hand-curated
 * default list when unset/empty.
 *
 * Injective (Circle-native USDC.inj) is the successor Cosmos-side USDC home now
 * that Noble is being wound down.
 */

import { useEffect, useState } from 'react';

const KEY = 'injectiveRpcPool';

/** hand-curated default pool (verified reachable 2026-09) */
const DEFAULT_POOL: readonly string[] = [
  'https://injective-rpc.publicnode.com:443',
  'https://rpc.cosmos.directory/injective',
  'https://sentry.tm.injective.network:443',
];

const clean = (list: string[]): string[] => list.map(u => u.trim()).filter(Boolean);

/** the shipped default pool */
export const defaultInjectiveRpcPool = (): string[] => [...DEFAULT_POOL];

/** effective pool: user's stored list if any, else the shipped default */
export const getInjectiveRpcPool = async (): Promise<string[]> => {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as string[] | undefined;
  const pool = stored ? clean(stored) : [];
  return pool.length ? pool : defaultInjectiveRpcPool();
};

/** persist the pool; an empty list clears the override (reverts to default) */
export const setInjectiveRpcPool = async (endpoints: string[]): Promise<void> => {
  await chrome.storage.local.set({ [KEY]: clean(endpoints) });
};

/** react hook: the effective pool + a setter, kept in sync with storage */
export const useInjectiveRpcPool = (): {
  pool: string[];
  isCustom: boolean;
  save: (endpoints: string[]) => Promise<void>;
  reset: () => Promise<void>;
} => {
  const [pool, setPool] = useState<string[]>(defaultInjectiveRpcPool());
  const [isCustom, setIsCustom] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const stored = (await chrome.storage.local.get(KEY))[KEY] as string[] | undefined;
      const custom = stored ? clean(stored) : [];
      if (alive) {
        setIsCustom(custom.length > 0);
        setPool(custom.length ? custom : defaultInjectiveRpcPool());
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
    save: (endpoints: string[]) => setInjectiveRpcPool(endpoints),
    reset: () => setInjectiveRpcPool([]),
  };
};
