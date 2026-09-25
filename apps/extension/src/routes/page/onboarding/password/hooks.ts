import { useAddWallet } from '../../../../hooks/onboarding';
import { usePageNav } from '../../../../utils/navigate';
import { FormEvent, useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getSeedPhraseOrigin } from './utils';
import { SEED_PHRASE_ORIGIN } from './types';
import { PagePath } from '../../paths';
import { localExtStorage } from '@repo/storage-chrome/local';
import { setOnboardingValuesInStorage, setFreshWalletBlockHeights } from '../persist-parameters';
import { PENDING_ZCASH_BIRTHDAY_KEY, PENDING_IMPORT_NETWORKS_KEY } from '../constants';
import { useStore } from '../../../../state';
import { keyRingSelector } from '../../../../state/keyring';
import type { NetworkType } from '../../../../state/keyring/network-types';
import { networksSelector } from '../../../../state/networks';
import { zignerConnectSelector } from '../../../../state/zigner';
import { ZCASH_MAINNET_ENDPOINTS, defaultZcashEndpoint } from '../../../../config/zcash-endpoints';
import type { ZignerZafuImport } from '../../../../state/keyring/types';

export const useFinalizeOnboarding = () => {
  const addWallet = useAddWallet();
  const navigate = usePageNav();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const location = useLocation();
  const { setPassword, newZignerZafuKey, toggleNetwork, setActiveNetwork, enabledNetworks } =
    useStore(keyRingSelector);
  const { setNetworkEndpoint } = useStore(networksSelector);
  const {
    walletImport,
    zcashWalletImport,
    parsedPolkadotExport,
    parsedCosmosExport,
    walletLabel,
    clearZignerState,
  } = useStore(zignerConnectSelector);

  const handleSubmit = useCallback(
    async (event: FormEvent, password: string) => {
      event.preventDefault();
      // Snapshot the wallets that already exist BEFORE this import writes
      // anything, so a failure rolls back to exactly this state. The old
      // rollback did remove('vaults'), which deleted every wallet on the
      // profile - a failed import must never take out the user's other wallets.
      const vaultsSnapshot = (await localExtStorage.get('vaults')) ?? [];
      const penumbraSnapshot = (await localExtStorage.get('penumbraWallets')) ?? [];

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
            // zcash zigner import — use ZID as canonical deviceId for dedup
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
        } else {
          // Standard mnemonic flow. A fresh wallet still defaults to Zcash only
          // (no network-select screen - minimizes first-run confusion). An
          // IMPORT recovers onto whatever the review step chose (both networks
          // derive from the same seed, so a user recovering a Penumbra wallet is
          // no longer forced through zcash). Enable + activate the chosen set
          // here, BEFORE addWallet, so the keys are derived as part of wallet
          // creation - these setters just record the choice (no wallet yet).
          const chosen = (sessionStorage.getItem(PENDING_IMPORT_NETWORKS_KEY) ?? '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean) as NetworkType[];
          const targets: NetworkType[] =
            origin === SEED_PHRASE_ORIGIN.IMPORTED && chosen.length > 0 ? chosen : ['zcash'];

          for (const net of targets) {
            if (!enabledNetworks.includes(net)) {
              await toggleNetwork(net);
            }
          }
          // Activate zcash if it's in the set (it owns the birthday/sync UX the
          // rest of onboarding set up); otherwise the first chosen network.
          await setActiveNetwork(targets.includes('zcash') ? 'zcash' : targets[0]!);
          if (targets.includes('zcash')) {
            const preset = ZCASH_MAINNET_ENDPOINTS.find(p => p.id === defaultZcashEndpoint().id);
            if (preset) {
              await setNetworkEndpoint('zcash', preset.url);
            }
          }

          // For fresh wallets, set block heights BEFORE creating wallet to avoid race condition
          if (origin === SEED_PHRASE_ORIGIN.NEWLY_GENERATED) {
            await setFreshWalletBlockHeights();
          }
          // Recover/import is idempotent by walletId: recovering the same seed
          // derives the same key, and the wallet layer must NOT create a second
          // record for it (that was the "same wallet appears multiple times"
          // bug). Adding an already-present wallet is therefore treated as
          // success - the existing record is selected rather than duplicated -
          // so this call must not be made to throw on "already exists".
          await addWallet(password);
        }

        await setOnboardingValuesInStorage(origin);

        // apply zcash birthday from onboarding (stored in sessionStorage by the
        // birthday step). Only imported wallets have one - a fresh wallet syncs
        // from the tip - so gate on origin so a stale value left behind by an
        // abandoned import (import -> back -> create) can never leak into a new
        // wallet. Always clear the key regardless.
        const pendingBirthday = sessionStorage.getItem(PENDING_ZCASH_BIRTHDAY_KEY);
        if (pendingBirthday && origin === SEED_PHRASE_ORIGIN.IMPORTED) {
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
        sessionStorage.removeItem(PENDING_IMPORT_NETWORKS_KEY);

        navigate(PagePath.ONBOARDING_SUCCESS, { state: { origin } });
      } catch (e) {
        setError(String(e));
        // roll back to the pre-import snapshot - restore what was there rather
        // than wiping everything, so a failed import leaves the user's existing
        // wallets untouched.
        await localExtStorage.set('vaults', vaultsSnapshot);
        await localExtStorage.set('penumbraWallets', penumbraSnapshot);
      } finally {
        setLoading(false);
      }
    },
    [
      walletImport,
      zcashWalletImport,
      parsedPolkadotExport,
      parsedCosmosExport,
      walletLabel,
      enabledNetworks,
      toggleNetwork,
      setActiveNetwork,
      setNetworkEndpoint,
    ],
  );

  return { handleSubmit, error, loading };
};
