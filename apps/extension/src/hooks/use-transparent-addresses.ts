/**
 * A pocket's transparent addresses, cached per pocket store (sealed at rest). Index 0 is the
 * one address the pocket shows. Every swap that leaves or lands on a
 * t-address (THORChain) takes a fresh index of its own above the highest
 * ever handed out, so two swaps never share an address on chain. The check
 * covers every index up to that highest one and none past it, so those
 * addresses are counted and shielded like the rest; older builds' rotated
 * indices sit in the same range, and a restored seed finds them by looking
 * back once (lookBackTAddresses).
 */

import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncrypted, writeEncrypted } from '../state/encrypted-storage';
import { useStore, type AllSlices } from '../state';
import { zcashViewKey } from '../state/zcash-view-key';
import { selectEffectiveKeyInfo, keyRingSelector, selectActiveNetwork } from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { deriveZcashTransparent, deriveZcashTransparentFromUfvk } from './use-address';
import { activeZcashStoreId, activeAccountIndex } from '../state/pockets';
import {
  pocketTransparentIndices,
  RESTORE_T_INDEX,
  T_SWEEP_BEFORE,
  tSweptKey,
  zcashTransparentIndexKey,
} from '../state/pocket-id';
import { highestFunded } from '../transparent/zcash-check';

/** why a wallet that exists has no transparent address */
export type NoTransparent = 'undecryptable' | 'no-transparent-key';

/** what a pocket's transparent addresses derive from, as the store has it now */
const tAddrSource = (s: AllSlices) => ({
  keyInfo: selectEffectiveKeyInfo(s),
  keyRing: keyRingSelector(s),
  watchOnly: selectActiveZcashWallet(s),
  // a pocket has its own t-branch m/44'/133'/pocket'/0/i; account 0 keeps the
  // historic storage keys, so existing addresses never shift
  pocket: activeAccountIndex(s),
  storeId: activeZcashStoreId(s),
  isZcash: selectActiveNetwork(s) === 'zcash',
});

interface TAddrs {
  tAddresses: string[];
  missing?: NoTransparent;
}
const NONE: TAddrs = { tAddresses: [] };

type TSource = ReturnType<typeof tAddrSource>;

/** the storage key of a pocket's highest handed-out t-index; watch-only wallets have one t-branch */
const indexKeyOf = ({ keyInfo, pocket }: TSource) =>
  zcashTransparentIndexKey(keyInfo?.type === 'mnemonic' ? pocket : 0);

/** the highest t-index ever handed out for this pocket; 0 when only the shown address was */
const highestIndex = async (key: string): Promise<number> => {
  const v: unknown = (await chrome.storage.local.get(key))[key];
  return Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0;
};

/**
 * The addresses at `indices`, from the seed or the UFVK. Throws `no-transparent-key`
 * when a watch-only key has no t-branch; [] when nothing can derive them.
 */
const deriveAt = async (
  { keyInfo, keyRing, watchOnly, pocket, isZcash }: TSource,
  indices: number[],
  isMainnet: boolean,
): Promise<string[]> => {
  // multisig UFVKs are orchard-only: no t-branch to derive
  if (!isZcash || !keyInfo || keyInfo.type === 'frost-multisig') {
    return [];
  }
  if (keyInfo.type === 'mnemonic') {
    const mnemonic = await keyRing.getMnemonic(keyInfo.id);
    return Promise.all(indices.map(i => deriveZcashTransparent(mnemonic, pocket, i, isMainnet)));
  }
  const ufvk = zcashViewKey(watchOnly);
  if (!ufvk) {
    return [];
  }
  try {
    return await Promise.all(indices.map(i => deriveZcashTransparentFromUfvk(ufvk, i)));
  } catch {
    throw new Error('no-transparent-key');
  }
};

/**
 * The query for a pocket's transparent addresses: the storage cache first,
 * else derived (seed or UFVK) and cached. Local only. Shared by the screens
 * and their intent preloads, so a screen opens with the addresses in hand.
 */
export const transparentAddressesQuery = (source: TSource, isMainnet: boolean) =>
  queryOptions({
    queryKey: [
      'zcashTAddrs',
      source.keyInfo?.id,
      source.storeId,
      source.pocket,
      isMainnet,
      source.isZcash,
    ],
    queryFn: async (): Promise<TAddrs> => {
      const { keyInfo, storeId } = source;
      if (!source.isZcash || !keyInfo || keyInfo.type === 'frost-multisig') {
        return NONE;
      }
      try {
        const indices = pocketTransparentIndices(await highestIndex(indexKeyOf(source)));

        // sealed at rest; an older plaintext cache reads as absent and is sealed over
        const cacheKey = `zcashTAddrs:${storeId ?? keyInfo.id}` as keyof LocalStorageState;
        const cached = await readEncrypted<unknown>(
          localExtStorage,
          sessionExtStorage,
          cacheKey,
        ).catch(() => null);
        if (
          Array.isArray(cached) &&
          cached.length >= indices.length &&
          cached.every(a => typeof a === 'string')
        ) {
          return { tAddresses: cached.slice(0, indices.length) };
        }

        const addrs = await deriveAt(source, indices, isMainnet);
        if (addrs.length > 0) {
          // not awaited: a sealed write waits for this realm's hydration
          void writeEncrypted(localExtStorage, sessionExtStorage, cacheKey, addrs);
        }
        return { tAddresses: addrs };
      } catch (err) {
        // A vault whose seed was sealed under a stale password key throws
        // 'failed to decrypt vault' - expected and recoverable (re-import),
        // not a bug. Surface it to the UI and keep the console quiet; anything
        // else is a genuine failure and stays a loud console.error.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'no-transparent-key') {
          return { tAddresses: [], missing: 'no-transparent-key' };
        }
        if (msg.includes('failed to decrypt vault')) {
          console.warn('[use-transparent-addresses] vault cannot be decrypted (re-import to fix)');
          return { tAddresses: [], missing: 'undecryptable' };
        }
        console.error('[use-transparent-addresses] derivation failed:', err);
        return NONE;
      }
    },
    retry: false,
  });

/** one swap's own transparent address: its t-branch index and the address */
export interface SwapTAddress {
  index: number;
  address: string;
}

/**
 * The address the next swap would take, one index above any handed out. Only
 * a look: nothing is claimed until a swap is confirmed (claimSwapTAddress), so
 * a dry price asked with it burns no index.
 */
export const nextSwapTAddressQuery = (source: TSource, isMainnet: boolean) =>
  queryOptions({
    queryKey: [
      'zcashSwapTAddr',
      source.keyInfo?.id,
      source.storeId,
      source.pocket,
      isMainnet,
      source.isZcash,
    ],
    queryFn: async (): Promise<SwapTAddress | null> => {
      const index = (await highestIndex(indexKeyOf(source))) + 1;
      const [address] = await deriveAt(source, [index], isMainnet).catch(() => []);
      return address ? { index, address } : null;
    },
    retry: false,
    staleTime: Infinity,
  });

/** every realm takes the same lock, so two swaps never claim one index */
const T_INDEX_LOCK = () => `${chrome.runtime.id}.zcash-t-index`;

/** move a pocket's highest handed-out index, under the lock; the scan and the next look follow */
const moveTIndex = async (
  key: string,
  to: (highest: number) => number,
  client?: QueryClient,
): Promise<number> => {
  const index = await navigator.locks.request(T_INDEX_LOCK(), { mode: 'exclusive' }, async () => {
    const next = to(await highestIndex(key));
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
  void client?.invalidateQueries({ queryKey: ['zcashTAddrs'] });
  void client?.invalidateQueries({ queryKey: ['zcashSwapTAddr'] });
  return index;
};

/**
 * Claim a fresh t-address for one swap: the next index above any ever handed
 * out, written before it is used so the scan covers it from now on (and a
 * reopened popup never hands it out again). A claim that is never used leaves
 * an empty address in the scan, nothing more.
 */
export const claimSwapTAddress = async (
  source: TSource,
  isMainnet: boolean,
  client?: QueryClient,
): Promise<SwapTAddress> => {
  const index = await moveTIndex(indexKeyOf(source), h => h + 1, client);
  const [address] = await deriveAt(source, [index], isMainnet);
  if (!address) {
    throw new Error('this wallet has no transparent address');
  }
  return { index, address };
};

/** the active pocket's transparent address at `index`: an lp address, derived again after a restore */
export const tAddressAt = async (
  s: AllSlices,
  index: number,
  isMainnet: boolean,
): Promise<string | undefined> => (await deriveAt(tAddrSource(s), [index], isMainnet))[0];

/** claim a fresh index for the active pocket, as a swap does: the pocket's one lp address */
export const claimTAddress = (s: AllSlices, isMainnet: boolean): Promise<SwapTAddress> =>
  claimSwapTAddress(tAddrSource(s), isMainnet);

/**
 * A restored seed's older addresses, asked once on the person's word: the
 * first twenty, each on its own. The highest that holds coins counts as
 * handed out from then on, so every check after covers it; the rest are
 * never asked again.
 */
export const lookBackTAddresses = async (
  source: TSource,
  isMainnet: boolean,
  ask: (addresses: string[]) => Promise<{ address: string }[]>,
  client?: QueryClient,
): Promise<void> => {
  const older = await deriveAt(source, pocketTransparentIndices(RESTORE_T_INDEX), isMainnet);
  const found = highestFunded(older, await ask(older));
  if (found > 0) {
    await moveTIndex(indexKeyOf(source), h => Math.max(h, found), client);
  }
  await chrome.storage.local.set({ [sweptKey(source)]: true });
  void client?.invalidateQueries({ queryKey: ['zcashTSweepDue'] });
};

const sweptKey = (source: TSource) => tSweptKey(source.storeId ?? source.keyInfo?.id ?? '');

/**
 * A pocket of a wallet made before this install asked only handed-out
 * addresses, that has not looked back yet: its first check looks back once.
 */
export const sweepDue = async (source: TSource): Promise<boolean> => {
  const key = sweptKey(source);
  const got = await chrome.storage.local.get([key, T_SWEEP_BEFORE]);
  const before: unknown = got[T_SWEEP_BEFORE];
  return (
    !got[key] && typeof before === 'number' && !!source.keyInfo && source.keyInfo.createdAt < before
  );
};

/** the transparent-address query for the active pocket, built from the store as it is now */
export const activeTransparentAddressesQuery = (s: AllSlices, isMainnet: boolean) =>
  transparentAddressesQuery(tAddrSource(s), isMainnet);

export function useTransparentAddresses(isMainnet: boolean) {
  const source = useStore(useShallow(tAddrSource));
  const { data = NONE, isPending } = useQuery(transparentAddressesQuery(source, isMainnet));
  const due = useQuery({
    queryKey: ['zcashTSweepDue', source.storeId, source.keyInfo?.id],
    queryFn: () => sweepDue(source),
    enabled: source.isZcash,
  }).data;
  return {
    /** this pocket's first check looks back once (sweepDue); undefined until read */
    due,
    tAddresses: data.tAddresses,
    isLoading: isPending,
    missing: data.missing,
    lookBack: (
      ask: (addresses: string[]) => Promise<{ address: string }[]>,
      client?: QueryClient,
    ) => lookBackTAddresses(source, isMainnet, ask, client),
  };
}

/**
 * A swap's fresh transparent address: `next` is the one a price may be asked
 * with, `claim` takes an index for good once the swap is confirmed.
 */
export function useSwapTAddress(isMainnet: boolean, client?: QueryClient) {
  const source = useStore(useShallow(tAddrSource));
  const next = useQuery(nextSwapTAddressQuery(source, isMainnet)).data ?? undefined;
  return { next, claim: () => claimSwapTAddress(source, isMainnet, client) };
}
