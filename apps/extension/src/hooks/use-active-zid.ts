/**
 * hook for the zid a wallet is presenting RIGHT NOW: its current generation
 * and that generation's public key.
 *
 * one source for every display surface (sidebar, identity page), so the name
 * a surface shows and the key its copy button hands out can never come from
 * different generations or different wallets.
 *
 * - mnemonic: the generation's key comes from the per-wallet cache, derived
 *   from THIS wallet's seed when missing
 * - zigner-zafu: the device-provided zid; there is no seed here to rotate, and
 *   the airgap sign path signs with this key whatever the index says
 */

import { useEffect, useState } from 'react';
import { useStore } from '../state';
import { selectGetMnemonic } from '../state/keyring';
import type { KeyInfo } from '../state/keyring/types';
import {
  ZID_GEN_KEYS_STORAGE_KEY,
  ZID_INDEX_STORAGE_KEY,
  deriveAndCacheZidGeneration,
  getZidGenKeys,
  getZidIndex,
} from '../state/identity';

export interface ActiveZid {
  /** the wallet's current generation */
  zidIndex: number;
  /** that generation's public key (hex), or undefined while unknown */
  zidPubkey: string | undefined;
}

export function useActiveZid(keyInfo: KeyInfo | undefined): ActiveZid {
  const getMnemonic = useStore(selectGetMnemonic);
  const walletId = keyInfo?.id ?? '';
  const storedZid = keyInfo?.insensitive?.['zid'] as string | undefined;
  const isAirgap = keyInfo?.type === 'zigner-zafu';

  const [zidIndex, setZidIndex] = useState(0);
  const [genKeys, setGenKeys] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!walletId) {
      setZidIndex(0);
      setGenKeys({});
      return;
    }
    let cancelled = false;
    const load = () =>
      void Promise.all([getZidIndex(walletId), getZidGenKeys(walletId)]).then(([idx, keys]) => {
        if (!cancelled) {
          setZidIndex(idx);
          setGenKeys(keys);
        }
      });
    load();
    // index and cache keys are `<prefix>:<walletId>` (plus the legacy bare
    // index key) - match by prefix
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (
        area === 'local' &&
        Object.keys(changes).some(
          k => k.startsWith(ZID_INDEX_STORAGE_KEY) || k.startsWith(ZID_GEN_KEYS_STORAGE_KEY),
        )
      ) {
        load();
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [walletId]);

  const zidPubkey = isAirgap
    ? storedZid
    : (genKeys[zidIndex] ?? (zidIndex === 0 ? storedZid : undefined));

  // derive + cache a missing generation from this wallet's own seed
  useEffect(() => {
    if (zidPubkey || !walletId || keyInfo?.type !== 'mnemonic') {
      return;
    }
    void (async () => {
      try {
        const mnemonic = await getMnemonic(walletId);
        await deriveAndCacheZidGeneration(mnemonic, zidIndex, walletId);
      } catch {
        /* locked - the cache listener fills it in once derived */
      }
    })();
  }, [zidPubkey, walletId, keyInfo?.type, zidIndex, getMnemonic]);

  return { zidIndex, zidPubkey };
}
