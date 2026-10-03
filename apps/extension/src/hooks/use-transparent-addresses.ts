/**
 * A pocket's transparent addresses, cached per pocket store. Index 0 is the
 * one address the pocket shows; the rest are legacy indices older builds
 * handed out, kept so their funds are still counted and shielded.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type AllSlices } from '../state';
import { selectEffectiveKeyInfo, keyRingSelector, selectActiveNetwork } from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { deriveZcashTransparent, deriveZcashTransparentFromUfvk } from './use-address';
import { activeZcashStoreId, activeAccountIndex } from '../state/pockets';
import { pocketTransparentIndices, zcashTransparentIndexKey } from '../state/pocket-id';

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

/**
 * The query for a pocket's transparent addresses: the storage cache first,
 * else derived (seed or UFVK) and cached. Local only. Shared by the screens
 * and their intent preloads, so a screen opens with the addresses in hand.
 */
export const transparentAddressesQuery = (
  { keyInfo, keyRing, watchOnly, pocket, storeId, isZcash }: ReturnType<typeof tAddrSource>,
  isMainnet: boolean,
) =>
  queryOptions({
    queryKey: ['zcashTAddrs', keyInfo?.id, storeId, pocket, isMainnet, isZcash],
    queryFn: async (): Promise<TAddrs> => {
      // multisig UFVKs are orchard-only: no t-branch to derive
      if (!isZcash || !keyInfo || keyInfo.type === 'frost-multisig') {
        return NONE;
      }
      const isMnemonic = keyInfo.type === 'mnemonic';
      try {
        const indexKey = zcashTransparentIndexKey(isMnemonic ? pocket : 0);
        const indices = pocketTransparentIndices(
          (await chrome.storage.local.get(indexKey))[indexKey],
        );

        const cacheKey = `zcashTAddrs:${storeId ?? keyInfo.id}`;
        const cached = (await chrome.storage.local.get(cacheKey))[cacheKey] as string[] | undefined;
        if (cached && cached.length >= indices.length) {
          return { tAddresses: cached.slice(0, indices.length) };
        }

        let addrs: string[] = [];
        if (isMnemonic) {
          const mnemonic = await keyRing.getMnemonic(keyInfo.id);
          addrs = await Promise.all(
            indices.map(i => deriveZcashTransparent(mnemonic, pocket, i, isMainnet)),
          );
        } else if (watchOnly) {
          const ufvk =
            watchOnly.ufvk ??
            (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
          if (!ufvk) {
            return NONE;
          }
          try {
            addrs = await Promise.all(indices.map(i => deriveZcashTransparentFromUfvk(ufvk, i)));
          } catch {
            return { tAddresses: [], missing: 'no-transparent-key' };
          }
        }
        if (addrs.length > 0) {
          await chrome.storage.local.set({ [cacheKey]: addrs });
        }
        return { tAddresses: addrs };
      } catch (err) {
        // A vault whose seed was sealed under a stale password key throws
        // 'failed to decrypt vault' - expected and recoverable (re-import),
        // not a bug. Surface it to the UI and keep the console quiet; anything
        // else is a genuine failure and stays a loud console.error.
        const msg = err instanceof Error ? err.message : String(err);
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

/** the transparent-address query for the active pocket, built from the store as it is now */
export const activeTransparentAddressesQuery = (s: AllSlices, isMainnet: boolean) =>
  transparentAddressesQuery(tAddrSource(s), isMainnet);

export function useTransparentAddresses(isMainnet: boolean) {
  const source = useStore(useShallow(tAddrSource));
  const { data = NONE, isPending } = useQuery(transparentAddressesQuery(source, isMainnet));
  return { tAddresses: data.tAddresses, isLoading: isPending, missing: data.missing };
}
