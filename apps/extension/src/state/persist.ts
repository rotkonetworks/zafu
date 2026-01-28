import { StateCreator, StoreMutatorIdentifier } from 'zustand';
import { AllSlices } from '.';
import { produce } from 'immer';

import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { localExtStorage } from '@repo/storage-chrome/local';
import { OriginRecord } from '@repo/storage-chrome/records';

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
    const grpcEndpoint = await localExtStorage.get('grpcEndpoint');
    const knownSites = await localExtStorage.get('knownSites');
    const frontendUrl = await localExtStorage.get('frontendUrl');
    const numeraires = await localExtStorage.get('numeraires');
    const zignerCameraEnabled = await localExtStorage.get('zignerCameraEnabled');

    set(
      produce((state: AllSlices) => {
        state.wallets.all = wallets;
        state.wallets.zcashWallets = zcashWallets ?? [];
        state.network.grpcEndpoint = grpcEndpoint;
        state.connectedSites.knownSites = knownSites as OriginRecord[];
        state.defaultFrontend.url = frontendUrl;
        state.numeraires.selectedNumeraires = numeraires;
        state.zigner.cameraEnabled = zignerCameraEnabled ?? false;
      }),
    );

    // Initialize keyring from storage (loads vaults, selected key, networks)
    await get().keyRing.init();

    // Part 2: when chrome.storage changes sync select fields to store
    localExtStorage.addListener(changes => {
      if (changes.wallets) {
        const wallets = changes.wallets.newValue;
        set(
          produce((state: AllSlices) => {
            state.wallets.all = wallets ?? [];
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
            state.wallets.zcashWallets = stored ?? [];
          }),
        );
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
