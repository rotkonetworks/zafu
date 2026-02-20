import { useAddWallet } from '../../../../hooks/onboarding';
import { usePageNav } from '../../../../utils/navigate';
import { FormEvent, useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getSeedPhraseOrigin } from './utils';
import { SEED_PHRASE_ORIGIN } from './types';
import { PagePath } from '../../paths';
import { localExtStorage } from '@repo/storage-chrome/local';
import { setOnboardingValuesInStorage, setFreshWalletBlockHeights } from '../persist-parameters';
import { useStore } from '../../../../state';
import { keyRingSelector } from '../../../../state/keyring';
import { zignerConnectSelector } from '../../../../state/zigner';
import type { ZignerZafuImport } from '../../../../state/keyring/types';

export const useFinalizeOnboarding = () => {
  const addWallet = useAddWallet();
  const navigate = usePageNav();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const location = useLocation();
  const { setPassword, newZignerZafuKey } = useStore(keyRingSelector);
  const { walletImport, zcashWalletImport, parsedPolkadotExport, parsedCosmosExport, walletLabel, clearZignerState } = useStore(zignerConnectSelector);

  const handleSubmit = useCallback(async (event: FormEvent, password: string) => {
    event.preventDefault();
    try {
      setLoading(true);
      setError(undefined);
      const origin = getSeedPhraseOrigin(location);

      if (origin === SEED_PHRASE_ORIGIN.ZIGNER) {
        // zigner flow: set password then import watch-only wallet
        await setPassword(password);

        if (walletImport) {
          // penumbra zigner import - convert protobuf to base64 strings
          const fvkInner = walletImport.fullViewingKey.inner;
          const walletIdInner = walletImport.walletId.inner;
          const zignerData: ZignerZafuImport = {
            fullViewingKey: fvkInner ? btoa(String.fromCharCode(...fvkInner)) : undefined,
            accountIndex: walletImport.accountIndex,
            deviceId: walletIdInner ? btoa(String.fromCharCode(...walletIdInner)) : `penumbra-${Date.now()}`,
          };
          await newZignerZafuKey(zignerData, walletLabel || 'zigner penumbra');
        } else if (zcashWalletImport) {
          // zcash zigner import
          const zignerData: ZignerZafuImport = {
            viewingKey: zcashWalletImport.orchardFvk
              ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk))
              : zcashWalletImport.ufvk ?? undefined,
            accountIndex: zcashWalletImport.accountIndex,
            deviceId: `zcash-${Date.now()}`,
          };
          await newZignerZafuKey(zignerData, walletLabel || 'zigner zcash');
        } else if (parsedCosmosExport) {
          // cosmos zigner import
          const zignerData: ZignerZafuImport = {
            cosmosAddresses: parsedCosmosExport.addresses,
            publicKey: parsedCosmosExport.publicKey || undefined,
            accountIndex: parsedCosmosExport.accountIndex,
            deviceId: `cosmos-${Date.now()}`,
          };
          await newZignerZafuKey(zignerData, walletLabel || 'zigner cosmos');
        } else if (parsedPolkadotExport) {
          // polkadot zigner import
          const zignerData: ZignerZafuImport = {
            polkadotSs58: parsedPolkadotExport.address,
            polkadotGenesisHash: parsedPolkadotExport.genesisHash,
            accountIndex: 0,
            deviceId: `polkadot-${Date.now()}`,
          };
          await newZignerZafuKey(zignerData, walletLabel || 'zigner polkadot');
        } else {
          throw new Error('no zigner wallet data found');
        }

        clearZignerState();
      } else {
        // standard mnemonic flow
        // For fresh wallets, set block heights BEFORE creating wallet to avoid race condition
        if (origin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED) {
          await setFreshWalletBlockHeights();
        }
        await addWallet(password);
      }

      await setOnboardingValuesInStorage(origin);
      navigate(PagePath.ONBOARDING_SUCCESS);
    } catch (e) {
      setError(String(e));
      // roll back on failure
      await localExtStorage.remove('wallets');
      await localExtStorage.remove('vaults');
    } finally {
      setLoading(false);
    }
  }, [walletImport, zcashWalletImport, parsedPolkadotExport, parsedCosmosExport, walletLabel]);

  return { handleSubmit, error, loading };
};
