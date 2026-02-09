/**
 * hook to get polkadot public key/address for the active vault
 *
 * returns the publicKey from vault insensitive data, polkadotSs58 for zigner wallets,
 * or derives from mnemonic
 */

import { useState, useEffect } from 'react';
import { localExtStorage } from '@repo/storage-chrome/local';
import { useStore } from '../state';
import { selectEffectiveKeyInfo } from '../state/keyring';

export function usePolkadotPublicKey() {
  // Use effective key info for current network (will be polkadot zigner when viewing polkadot)
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
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
        // For zigner-zafu wallets, get the polkadotSs58 address from encrypted data
        if (selectedKeyInfo.type === 'zigner-zafu') {
          const supportedNetworks = selectedKeyInfo.insensitive?.['supportedNetworks'] as string[] | undefined;
          if (supportedNetworks?.includes('polkadot')) {
            // This is a polkadot zigner wallet - need to get the address from vault data
            const vaults = await localExtStorage.get('vaults');
            const vault = vaults?.find((v: { id: string }) => v.id === selectedKeyInfo.id);

            if (vault) {
              // Decrypt the vault to get polkadotSs58
              // Note: For watch-only display, we can store the ss58 address in insensitive
              const ss58Address = vault.insensitive?.['polkadotSs58'] as string | undefined;
              if (ss58Address) {
                if (!cancelled) setPublicKey(ss58Address);
                if (!cancelled) setLoading(false);
                return;
              }
            }
          }
        }

        // check insensitive data for polkadot public key (mnemonic wallets)
        const polkadotKey = selectedKeyInfo.insensitive?.['polkadotPublicKey'] as string | undefined;
        if (polkadotKey) {
          if (!cancelled) setPublicKey(polkadotKey);
        } else {
          // fallback: check vault storage directly
          const vaults = await localExtStorage.get('vaults');
          const vault = vaults?.find((v: { id: string }) => v.id === selectedKeyInfo.id);
          const storedKey = vault?.insensitive?.['polkadotPublicKey'] as string | undefined;
          const storedSs58 = vault?.insensitive?.['polkadotSs58'] as string | undefined;

          if (!cancelled) setPublicKey(storedKey ?? storedSs58 ?? '');
        }
      } catch (err) {
        console.error('failed to load polkadot key:', err);
        if (!cancelled) setPublicKey('');
      }

      if (!cancelled) setLoading(false);
    };

    void loadPublicKey();
    return () => { cancelled = true; };
  }, [selectedKeyInfo?.id, selectedKeyInfo?.type]);

  return { publicKey, loading };
}
