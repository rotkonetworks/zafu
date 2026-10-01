/**
 * A pocket's transparent addresses, cached per pocket store. Index 0 is the
 * one address the pocket shows; the rest are legacy indices older builds
 * handed out, kept so their funds are still counted and shielded.
 */

import { useState, useEffect } from 'react';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, keyRingSelector, selectActiveNetwork } from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { deriveZcashTransparent, deriveZcashTransparentFromUfvk } from './use-address';
import { activeZcashStoreId, activeAccountIndex } from '../state/pockets';
import { pocketTransparentIndices, zcashTransparentIndexKey } from '../state/pocket-id';

/** why a wallet that exists has no transparent address */
export type NoTransparent = 'undecryptable' | 'no-transparent-key';

export function useTransparentAddresses(isMainnet: boolean) {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const keyRing = useStore(keyRingSelector);
  const watchOnly = useStore(selectActiveZcashWallet);
  // a pocket has its own t-branch m/44'/133'/pocket'/0/i; account 0 keeps the
  // historic storage keys, so existing addresses never shift
  const pocket = useStore(activeAccountIndex);
  const storeId = useStore(activeZcashStoreId);
  const isZcash = useStore(s => selectActiveNetwork(s) === 'zcash');

  const [tAddresses, setTAddresses] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [missing, setMissing] = useState<NoTransparent>();

  const isMnemonic = selectedKeyInfo?.type === 'mnemonic';

  useEffect(() => {
    // clear before deriving - previous vault's addresses would otherwise
    // bleed into the new vault's history query when derivation bails out.
    setTAddresses([]);
    setMissing(undefined);

    // multisig UFVKs are orchard-only: no t-branch to derive
    if (!isZcash || !selectedKeyInfo || selectedKeyInfo.type === 'frost-multisig') {
      setIsLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      try {
        const indexKey = zcashTransparentIndexKey(isMnemonic ? pocket : 0);
        const indices = pocketTransparentIndices(
          (await chrome.storage.local.get(indexKey))[indexKey],
        );
        const expectedCount = indices.length;

        // check cache
        const cacheKey = `zcashTAddrs:${storeId ?? selectedKeyInfo.id}`;
        const cached = await chrome.storage.local.get(cacheKey);
        const cachedAddrs = cached[cacheKey] as string[] | undefined;
        if (cachedAddrs && cachedAddrs.length >= expectedCount) {
          if (!cancelled) {
            setTAddresses(cachedAddrs.slice(0, expectedCount));
            setIsLoading(false);
          }
          return;
        }

        let addrs: string[] = [];

        if (isMnemonic) {
          const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
          addrs = await Promise.all(
            indices.map(i => deriveZcashTransparent(mnemonic, pocket, i, isMainnet)),
          );
        } else if (watchOnly) {
          const ufvk =
            watchOnly.ufvk ??
            (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
          if (!ufvk) {
            if (!cancelled) {
              setIsLoading(false);
            }
            return;
          }
          try {
            addrs = await Promise.all(indices.map(i => deriveZcashTransparentFromUfvk(ufvk, i)));
          } catch {
            if (!cancelled) {
              setMissing('no-transparent-key');
              setIsLoading(false);
            }
            return;
          }
        }

        if (addrs.length > 0 && !cancelled) {
          // cache for future use
          await chrome.storage.local.set({ [cacheKey]: addrs });
          setTAddresses(addrs);
        }
      } catch (err) {
        // A vault whose seed was sealed under a stale password key throws
        // 'failed to decrypt vault' - expected and recoverable (re-import),
        // not a bug. Surface it to the UI and keep the console quiet; anything
        // else is a genuine failure and stays a loud console.error.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('failed to decrypt vault')) {
          if (!cancelled) {
            setMissing('undecryptable');
          }
          console.warn('[use-transparent-addresses] vault cannot be decrypted (re-import to fix)');
        } else {
          console.error('[use-transparent-addresses] derivation failed:', err);
        }
      }
      if (!cancelled) {
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isZcash,
    isMnemonic,
    pocket,
    storeId,
    selectedKeyInfo?.id,
    selectedKeyInfo?.type,
    isMainnet,
    keyRing,
    watchOnly?.ufvk,
    watchOnly?.orchardFvk,
  ]);

  return { tAddresses, isLoading, missing };
}
