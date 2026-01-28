/**
 * hook to get polkadot public key for the active vault
 *
 * returns the publicKey from vault insensitive data or derives from mnemonic
 */

import { useState, useEffect } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../state';
import { selectSelectedKeyInfo } from '../state/keyring';

export function usePolkadotPublicKey() {
  const selectedKeyInfo = useStore(selectSelectedKeyInfo);
  const [publicKey, setPublicKey] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadPublicKey = async () => {
      setLoading(true);

      if (!selectedKeyInfo) {
        if (!cancelled) {
          setPublicKey('');
          setLoading(false);
        }
        return;
      }

      try {
        // check insensitive data for polkadot public key
        const polkadotKey = selectedKeyInfo.insensitive?.['polkadotPublicKey'] as string | undefined;
        if (polkadotKey) {
          if (!cancelled) setPublicKey(polkadotKey);
        } else {
          // fallback: check vault storage directly
          const vaults = await localExtStorage.get('vaults');
          const vault = vaults?.find((v: { id: string }) => v.id === selectedKeyInfo.id);
          const storedKey = vault?.insensitive?.['polkadotPublicKey'] as string | undefined;

          if (!cancelled) setPublicKey(storedKey ?? '');
        }
      } catch (err) {
        console.error('failed to load polkadot key:', err);
        if (!cancelled) setPublicKey('');
      }

      if (!cancelled) setLoading(false);
    };

    void loadPublicKey();
    return () => { cancelled = true; };
  }, [selectedKeyInfo?.id]);

  return { publicKey, loading };
}
