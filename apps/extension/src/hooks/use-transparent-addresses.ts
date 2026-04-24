/**
 * shared hook to derive and cache zcash transparent addresses
 *
 * avoids duplicate derivation across home + history pages
 * caches in chrome.storage.local keyed by walletId
 */

import { useState, useEffect } from 'react';
import { useStore } from '../state';
import { selectEffectiveKeyInfo, keyRingSelector } from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { deriveZcashTransparent, deriveZcashTransparentFromUfvk } from './use-address';

export function useTransparentAddresses(isMainnet: boolean) {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const keyRing = useStore(keyRingSelector);
  const watchOnly = useStore(selectActiveZcashWallet);

  const [tAddresses, setTAddresses] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const isMnemonic = selectedKeyInfo?.type === 'mnemonic';

  useEffect(() => {
    // clear before deriving — previous vault's addresses would otherwise
    // bleed into the new vault's history query when derivation bails out.
    setTAddresses([]);

    if (!selectedKeyInfo) {
      setIsLoading(false);
      return;
    }
    if (selectedKeyInfo.type === 'frost-multisig') {
      setIsLoading(false);
      return;
    }
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      try {
        const r = await chrome.storage.local.get('zcashTransparentIndex');
        const storedIdx = r['zcashTransparentIndex'] ?? 0;
        const maxIdx = Math.max(4, storedIdx);
        const expectedCount = maxIdx + 1;

        // check cache
        const cacheKey = `zcashTAddrs:${selectedKeyInfo.id}`;
        const cached = await chrome.storage.local.get(cacheKey);
        const cachedAddrs = cached[cacheKey] as string[] | undefined;
        if (cachedAddrs && cachedAddrs.length >= expectedCount) {
          if (!cancelled) {
            setTAddresses(cachedAddrs.slice(0, expectedCount));
            setIsLoading(false);
          }
          return;
        }

        // derive
        const indices = Array.from({ length: expectedCount }, (_, i) => i);
        let addrs: string[] = [];

        if (isMnemonic) {
          const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
          addrs = await Promise.all(
            indices.map(i => deriveZcashTransparent(mnemonic, 0, i, isMainnet)),
          );
        } else if (watchOnly) {
          const ufvk = watchOnly.ufvk ?? (watchOnly.orchardFvk?.startsWith('uview') ? watchOnly.orchardFvk : undefined);
          if (!ufvk) {
            if (!cancelled) setIsLoading(false);
            return;
          }
          try {
            addrs = await Promise.all(
              indices.map(i => deriveZcashTransparentFromUfvk(ufvk, i)),
            );
          } catch {
            // UFVK may lack transparent component
            if (!cancelled) setIsLoading(false);
            return;
          }
        }

        if (addrs.length > 0 && !cancelled) {
          // cache for future use
          await chrome.storage.local.set({ [cacheKey]: addrs });
          setTAddresses(addrs);
        }
      } catch (err) {
        console.error('[use-transparent-addresses] derivation failed:', err);
      }
      if (!cancelled) setIsLoading(false);
    })();

    return () => { cancelled = true; };
  }, [isMnemonic, selectedKeyInfo?.id, selectedKeyInfo?.type, isMainnet, keyRing, watchOnly?.ufvk, watchOnly?.orchardFvk]);

  return { tAddresses, isLoading };
}
