import { useAddWallet } from '../../../../hooks/onboarding';
import { usePageNav } from '../../../../utils/navigate';
import { useState } from 'react';
import { SEED_PHRASE_ORIGIN } from './types';
import { PagePath } from '../../paths';
import { localExtStorage } from '@repo/storage-chrome/local';
import { setOnboardingValuesInStorage } from '../persist-parameters';
import { PENDING_ZCASH_BIRTHDAY_KEY } from '../constants';
import { useStore } from '../../../../state';
import { keyRingSelector } from '../../../../state/keyring';
import { networksSelector } from '../../../../state/networks';
import { zignerConnectSelector } from '../../../../state/zigner';
import { ZCASH_MAINNET_ENDPOINTS, defaultZcashEndpoint } from '../../../../config/zcash-endpoints';
import type { ZignerZafuImport } from '../../../../state/keyring/types';
import { viewingKeyImport } from '../../../../hooks/use-viewing-key';
import { useOnboarding } from '..';
import { BIRTHDAY_PATH } from '../flow';

export const useFinalizeOnboarding = () => {
  const addWallet = useAddWallet();
  const navigate = usePageNav();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const {
    setPassword,
    newZignerZafuKey,
    addZignerUnencrypted,
    toggleNetwork,
    setActiveNetwork,
    enabledNetworks,
  } = useStore(keyRingSelector);
  const { viewingKey } = useOnboarding();
  const { setNetworkEndpoint } = useStore(networksSelector);
  const {
    walletImport,
    zcashWalletImport,
    parsedPolkadotExport,
    parsedCosmosExport,
    walletLabel,
    clearZignerState,
  } = useStore(zignerConnectSelector);

  // Both fresh and imported wallets are Zcash only out of onboarding - no
  // network-select screen anywhere in this flow. Penumbra (same seed,
  // derivable any time) is a settings > networks toggle once the wallet exists.
  const zcashOnly = async () => {
    if (!enabledNetworks.includes('zcash')) {
      await toggleNetwork('zcash');
    }
    await setActiveNetwork('zcash');
    const preset = ZCASH_MAINNET_ENDPOINTS.find(p => p.id === defaultZcashEndpoint().id);
    if (preset) {
      await setNetworkEndpoint('zcash', preset.url);
    }
  };

  // a watch-only wallet: sealed under the real password, never airgap-only
  const addViewingKey = async (password: string) => {
    await setPassword(password);
    await zcashOnly();
    await addZignerUnencrypted(await viewingKeyImport(viewingKey), 'viewing key');
  };

  const addZigner = async (password: string) => {
    // zigner flow: set password then import watch-only wallet
    await setPassword(password);

    if (walletImport) {
      // penumbra zigner import - convert protobuf to base64 strings
      const fvkInner = walletImport.fullViewingKey.inner;
      const walletIdInner = walletImport.walletId.inner;
      const legacyDeviceId = walletIdInner
        ? btoa(String.fromCharCode(...walletIdInner))
        : `penumbra-${Date.now()}`;
      const zignerData: ZignerZafuImport = {
        fullViewingKey: fvkInner ? btoa(String.fromCharCode(...fvkInner)) : undefined,
        accountIndex: walletImport.accountIndex,
        deviceId: walletImport.zidPublicKey ?? legacyDeviceId,
        zidPublicKey: walletImport.zidPublicKey,
      };
      await newZignerZafuKey(zignerData, walletLabel || 'zigner penumbra');
    } else if (zcashWalletImport) {
      // zcash zigner import - use ZID as canonical deviceId for dedup
      const zignerData: ZignerZafuImport = {
        viewingKey: zcashWalletImport.orchardFvk
          ? btoa(String.fromCharCode(...zcashWalletImport.orchardFvk))
          : (zcashWalletImport.ufvk ?? undefined),
        accountIndex: zcashWalletImport.accountIndex,
        deviceId: zcashWalletImport.zidPublicKey ?? `zcash-${Date.now()}`,
        zidPublicKey: zcashWalletImport.zidPublicKey,
      };
      await newZignerZafuKey(zignerData, walletLabel || 'zigner zcash');
    } else if (parsedCosmosExport) {
      // cosmos zigner import
      const zignerData: ZignerZafuImport = {
        cosmosAddresses: parsedCosmosExport.addresses,
        cosmosXpub: parsedCosmosExport.xpub,
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
  };

  const addMnemonic = async (password: string, origin: SEED_PHRASE_ORIGIN) => {
    await zcashOnly();
    // Recover/import is idempotent by walletId: recovering the same seed
    // derives the same key, and the wallet layer must NOT create a second
    // record for it (that was the "same wallet appears multiple times"
    // bug). Adding an already-present wallet is therefore treated as
    // success - the existing record is selected rather than duplicated -
    // so this call must not be made to throw on "already exists".
    await addWallet(password, origin);
  };

  const ADD: Partial<Record<SEED_PHRASE_ORIGIN, (password: string) => Promise<void>>> = {
    [SEED_PHRASE_ORIGIN.ZIGNER]: addZigner,
    [SEED_PHRASE_ORIGIN.VIEWING_KEY]: addViewingKey,
  };

  const finalize = async (origin: SEED_PHRASE_ORIGIN, password: string) => {
    if (loading) {
      return;
    }
    // Snapshot the wallets that already exist BEFORE this import writes
    // anything, so a failure rolls back to exactly this state. The old
    // rollback did remove('vaults'), which deleted every wallet on the
    // profile - a failed import must never take out the user's other wallets.
    const vaultsSnapshot = (await localExtStorage.get('vaults')) ?? [];
    const penumbraSnapshot = (await localExtStorage.get('penumbraWallets')) ?? [];

    try {
      setLoading(true);
      setError(undefined);

      await (ADD[origin] ?? (pw => addMnemonic(pw, origin)))(password);

      await setOnboardingValuesInStorage(origin);

      // apply zcash birthday from onboarding (stored in sessionStorage by the
      // birthday step). Only the import paths have one - a fresh wallet syncs
      // from the tip - so gate on origin so a stale value left behind by an
      // abandoned import (import -> back -> create) can never leak into a new
      // wallet. Always clear the key regardless.
      const pendingBirthday = sessionStorage.getItem(PENDING_ZCASH_BIRTHDAY_KEY);
      if (pendingBirthday && origin in BIRTHDAY_PATH) {
        // Use the selected vault, not vaults[0]. Under dedupe an idempotent
        // re-import lands on an EXISTING vault which is not necessarily first
        // in the list, so anchoring the birthday to index 0 would write it
        // onto the wrong wallet. selectedVaultId always points at the vault
        // this import resolved to (fresh or matched).
        const vaultId = await localExtStorage.get('selectedVaultId');
        if (vaultId) {
          const birthdayKey = `zcashBirthday_${vaultId}`;
          const newHeight = parseInt(pendingBirthday, 10);
          // Only LOWER an existing birthday, never raise it. When a re-import
          // resolves to an already-synced existing vault, writing a LATER
          // height would make the scanner skip notes below it - money-adjacent
          // data loss. So write only if there is no birthday yet, or the new
          // height is earlier than the stored one; otherwise leave it alone.
          const stored = (await chrome.storage.local.get(birthdayKey))[birthdayKey] as
            | number
            | undefined;
          if (
            Number.isFinite(newHeight) &&
            (stored === undefined || !Number.isFinite(stored) || newHeight < stored)
          ) {
            await chrome.storage.local.set({ [birthdayKey]: newHeight });
          }
        }
      }
      sessionStorage.removeItem(PENDING_ZCASH_BIRTHDAY_KEY);

      navigate(PagePath.ONBOARDING_SUCCESS, { state: { origin } });
    } catch (e) {
      console.error('[onboarding] finalize failed', e);
      setError('something broke on our side, not yours · nothing was saved, please try again');
      // roll back to the pre-import snapshot - restore what was there rather
      // than wiping everything, so a failed import leaves the user's existing
      // wallets untouched.
      await localExtStorage.set('vaults', vaultsSnapshot);
      await localExtStorage.set('penumbraWallets', penumbraSnapshot);
    } finally {
      setLoading(false);
    }
  };

  return { finalize, error, loading };
};
