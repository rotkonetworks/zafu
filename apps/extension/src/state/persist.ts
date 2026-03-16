import { StateCreator, StoreMutatorIdentifier } from 'zustand';
import { AllSlices } from '.';
import { produce } from 'immer';

import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { OriginRecord } from '@repo/storage-chrome/records';
import { readEncrypted } from './encrypted-storage';
import type { Contact } from './contacts';
import type { RecentAddress } from './recent-addresses';

export type Middleware = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  f: StateCreator<T, Mps, Mcs>,
) => StateCreator<T, Mps, Mcs>;

type Persist = (f: StateCreator<AllSlices>) => StateCreator<AllSlices>;

export const customPersistImpl: Persist = f => (set, get, store) => {
  void (async function () {
    // Part 1: Get storage values and sync them to store
    const wallets = await localExtStorage.get('wallets');
    const zcashWallets = await localExtStorage.get('zcashWallets');
    const activeZcashIndex = await localExtStorage.get('activeZcashIndex');
    const activeWalletIndex = await localExtStorage.get('activeWalletIndex');
    const grpcEndpoint = await localExtStorage.get('grpcEndpoint');
    const knownSites = await localExtStorage.get('knownSites');
    const frontendUrl = await localExtStorage.get('frontendUrl');
    const numeraires = await localExtStorage.get('numeraires');
    const zignerCameraEnabled = await localExtStorage.get('zignerCameraEnabled');
    const privacySettings = await localExtStorage.get('privacySettings' as keyof import('@repo/storage-chrome/local').LocalStorageState);

    set(
      produce((state: AllSlices) => {
        state.wallets.all = wallets.map(w => ({ ...w, vaultId: w.vaultId ?? '' })) as typeof state.wallets.all;
        state.wallets.zcashWallets = (zcashWallets ?? []).map(w => ({ ...w, vaultId: w.vaultId ?? '' })) as typeof state.wallets.zcashWallets;
        state.wallets.activeZcashIndex = activeZcashIndex ?? 0;
        state.wallets.activeIndex = activeWalletIndex ?? 0;
        state.network.grpcEndpoint = grpcEndpoint;
        state.connectedSites.knownSites = knownSites as OriginRecord[];
        state.defaultFrontend.url = frontendUrl;
        state.numeraires.selectedNumeraires = numeraires;
        state.zigner.cameraEnabled = zignerCameraEnabled ?? false;
        if (privacySettings) {
          state.privacy.settings = privacySettings as AllSlices['privacy']['settings'];
        }
      }),
    );

    // hydrate encrypted user data — standalone service, called on any unlock event
    const hydrateEncryptedData = async () => {
      const [contacts, recentAddresses] = await Promise.all([
        readEncrypted<Contact[]>(localExtStorage, sessionExtStorage, 'contacts' as keyof import('@repo/storage-chrome/local').LocalStorageState),
        readEncrypted<RecentAddress[]>(localExtStorage, sessionExtStorage, 'recentAddresses' as keyof import('@repo/storage-chrome/local').LocalStorageState),
      ]);
      set(produce((state: AllSlices) => {
        if (contacts) state.contacts.contacts = contacts;
        if (recentAddresses) state.recentAddresses.recentAddresses = recentAddresses;
      }));
    };

    // Initialize keyring from storage (loads vaults, selected key, networks)
    await get().keyRing.init();

    // hydrate now (works if already unlocked or auto-unlocked)
    await hydrateEncryptedData();

    // subscribe to status changes — re-hydrate when keyring transitions to 'unlocked'
    // dataflow: react to state change, not imperative wrapping of unlock()
    let prevStatus = get().keyRing.status;
    store.subscribe((state: AllSlices) => {
      const status = state.keyRing.status;
      if (status === 'unlocked' && prevStatus !== 'unlocked') {
        void hydrateEncryptedData();
      }
      prevStatus = status;
    });

    // Part 2: when chrome.storage changes sync select fields to store
    localExtStorage.addListener(changes => {
      if (changes.wallets) {
        const wallets = changes.wallets.newValue;
        set(
          produce((state: AllSlices) => {
            state.wallets.all = (wallets ?? []).map(w => ({ ...w, vaultId: w.vaultId ?? '' })) as typeof state.wallets.all;
          }),
        );
      }

      if (changes.fullSyncHeight) {
        const stored = changes.fullSyncHeight.newValue;
        set(
          produce((state: AllSlices) => {
            state.network.fullSyncHeight = stored ?? 0;
          }),
        );
      }

      if (changes.grpcEndpoint) {
        const stored = changes.grpcEndpoint.newValue;
        set(
          produce((state: AllSlices) => {
            state.network.grpcEndpoint = stored ?? state.network.grpcEndpoint;
          }),
        );
      }

      if (changes.knownSites) {
        const stored = changes.knownSites.newValue as OriginRecord[] | undefined;
        set(
          produce((state: AllSlices) => {
            state.connectedSites.knownSites = stored ?? state.connectedSites.knownSites;
          }),
        );
      }

      if (changes.frontendUrl) {
        const stored = changes.frontendUrl.newValue;
        set(
          produce((state: AllSlices) => {
            state.defaultFrontend.url = stored ?? state.defaultFrontend.url;
          }),
        );
      }

      if (changes.numeraires) {
        const stored = changes.numeraires.newValue;
        set(
          produce((state: AllSlices) => {
            state.numeraires.selectedNumeraires = stored ?? state.numeraires.selectedNumeraires;
          }),
        );
      }

      if (changes.params) {
        const stored = changes.params.newValue;
        set(
          produce((state: AllSlices) => {
            state.network.chainId = stored
              ? AppParameters.fromJsonString(stored).chainId
              : state.network.chainId;
          }),
        );
      }

      if (changes.zignerCameraEnabled) {
        const stored = changes.zignerCameraEnabled.newValue;
        set(
          produce((state: AllSlices) => {
            state.zigner.cameraEnabled = stored ?? false;
          }),
        );
      }

      if (changes.zcashWallets) {
        const stored = changes.zcashWallets.newValue;
        set(
          produce((state: AllSlices) => {
            state.wallets.zcashWallets = (stored ?? []).map(w => ({ ...w, vaultId: w.vaultId ?? '' })) as typeof state.wallets.zcashWallets;
          }),
        );
      }

      if (changes.activeZcashIndex) {
        const stored = changes.activeZcashIndex.newValue;
        set(
          produce((state: AllSlices) => {
            state.wallets.activeZcashIndex = stored ?? 0;
          }),
        );
      }

      if (changes.contacts) {
        // contacts may be encrypted — re-read through decryption layer
        void readEncrypted<Contact[]>(localExtStorage, sessionExtStorage, 'contacts' as keyof import('@repo/storage-chrome/local').LocalStorageState)
          .then(decrypted => {
            if (decrypted) {
              set(produce((state: AllSlices) => { state.contacts.contacts = decrypted; }));
            }
          });
      }

      if (changes.activeWalletIndex) {
        const stored = changes.activeWalletIndex.newValue;
        set(
          produce((state: AllSlices) => {
            state.wallets.activeIndex = stored ?? 0;
          }),
        );
      }

      if (changes.enabledNetworks) {
        const stored = changes.enabledNetworks.newValue;
        set(
          produce((state: AllSlices) => {
            state.keyRing.enabledNetworks = (stored ?? []) as AllSlices['keyRing']['enabledNetworks'];
          }),
        );
      }

      const privacyChange = (changes as Record<string, { newValue?: unknown }>)['privacySettings'];
      if (privacyChange) {
        const stored = privacyChange.newValue;
        if (stored) {
          set(
            produce((state: AllSlices) => {
              state.privacy.settings = stored as AllSlices['privacy']['settings'];
            }),
          );
        }
      }

      // re-init keyring if vaults or selected vault changes
      if (changes.vaults || changes.selectedVaultId) {
        void get().keyRing.init();
      }
    });
  })();

  return f(set, get, store);
};

export const customPersist = customPersistImpl as Middleware;
