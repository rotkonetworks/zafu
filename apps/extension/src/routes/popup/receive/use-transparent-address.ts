/**
 * Zcash transparent address derivation + burner rotation, split out of
 * receive-tab.tsx. A transparent address is public and, in this wallet's
 * design, a recoverable burner - reusing one lets senders link your
 * payments. So when the transparent tab opens we scan forward from the
 * last-known index for the first UNUSED address (no on-chain history) and
 * default to it; the caller can still step through earlier (used) indices.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../../../state';
import { keyRingSelector, selectEffectiveKeyInfo } from '../../../state/keyring';
import { selectActiveZcashWallet } from '../../../state/wallets';
import { activeAccountIndex } from '../../../state/pockets';
import { zcashTransparentIndexKey } from '../../../state/pocket-id';
import { getTransparentHistoryInWorker } from '../../../state/keyring/network-worker';
import { deriveZcashTransparent, deriveZcashTransparentFromUfvk } from '../../../hooks/use-address';

const SCAN_GAP = 20;

export function useTransparentAddress(active: boolean) {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const keyRing = useStore(keyRingSelector);
  const zcashWallet = useStore(selectActiveZcashWallet);
  const pocket = useStore(activeAccountIndex);
  const indexKey = zcashTransparentIndexKey(pocket);
  const zidecarUrl = useStore(s => s.networks.networks.zcash.endpoint) || 'https://zcash.rotko.net';

  const isMnemonic = selectedKeyInfo?.type === 'mnemonic';
  const isMultisig = selectedKeyInfo?.type === 'frost-multisig';
  const zcashUfvk =
    zcashWallet?.ufvk ??
    (zcashWallet?.orchardFvk?.startsWith('uview') ? zcashWallet.orchardFvk : undefined);
  // multisig UFVKs are orchard-only, no transparent component to derive.
  const canDerive = (isMnemonic || !!zcashUfvk) && !isMultisig;

  const [index, setIndex] = useState(0);
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [used, setUsed] = useState(false);

  const deriveAt = async (i: number): Promise<string | undefined> => {
    if (isMnemonic && selectedKeyInfo) {
      const mnemonic = await keyRing.getMnemonic(selectedKeyInfo.id);
      return deriveZcashTransparent(mnemonic, pocket, i, true);
    }
    if (zcashUfvk) {
      return deriveZcashTransparentFromUfvk(zcashUfvk, i);
    }
    return undefined;
  };

  // default to the first unused index, scanning forward from the last-known
  // one. Best-effort: any failure leaves the stored index in place.
  useEffect(() => {
    if (!active || !canDerive) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const stored = (await chrome.storage.local.get(indexKey))[indexKey] as
          | number
          | undefined;
        const start = typeof stored === 'number' && stored > 0 ? stored : 0;
        for (let i = start; i <= start + SCAN_GAP; i++) {
          if (cancelled) {
            return;
          }
          const addr = await deriveAt(i);
          if (!addr) {
            return;
          }
          const hist = await getTransparentHistoryInWorker('zcash', zidecarUrl, [addr]).catch(
            () => [],
          );
          if (cancelled) {
            return;
          }
          if (hist.length === 0) {
            setIndex(i);
            void chrome.storage.local.set({ [indexKey]: i });
            return;
          }
        }
      } catch {
        // best-effort: on any failure keep whatever index is set
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, canDerive, isMnemonic, selectedKeyInfo, keyRing, zcashUfvk, zidecarUrl, indexKey]);

  // derive the address for the current index
  useEffect(() => {
    if (!active || !canDerive) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void deriveAt(index)
      .then(addr => {
        if (cancelled) {
          return;
        }
        setAddress(addr ?? '');
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        setError(
          msg.includes('no transparent component')
            ? 'this wallet key does not include a transparent key - re-import from an updated zigner to enable transparent addresses'
            : msg,
        );
        setAddress('');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, index, canDerive, isMnemonic, zcashUfvk, pocket]);

  // reuse probe: does the current address already have on-chain history?
  useEffect(() => {
    if (!active || !address) {
      setUsed(false);
      return;
    }
    let cancelled = false;
    void getTransparentHistoryInWorker('zcash', zidecarUrl, [address])
      .then(hist => {
        if (!cancelled && hist.length > 0) {
          setUsed(true);
        }
      })
      .catch(() => {
        /* probe is best-effort - never block showing the address */
      });
    return () => {
      cancelled = true;
    };
  }, [active, address, zidecarUrl]);

  const advance = () => {
    setIndex(i => {
      const next = i + 1;
      void chrome.storage.local.get(indexKey).then(r => {
        if (next > ((r[indexKey] as number | undefined) ?? 0)) {
          void chrome.storage.local.set({ [indexKey]: next });
        }
      });
      return next;
    });
  };

  return { canDerive, index, setIndex, advance, address, loading, error, used };
}
