import { create, StateCreator } from 'zustand';
import { createWalletsSlice, WalletsSlice } from './wallets';
import { immer } from 'zustand/middleware/immer';
import { customPersist } from './persist';
import { createPasswordSlice, PasswordSlice } from './password';
import { createSeedPhraseSlice, SeedPhraseSlice } from './seed-phrase';
import { createNetworkSlice, NetworkSlice } from './network';
import { createActiveNetworkSlice, ActiveNetworkSlice } from './active-network';
import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage, type SessionStorageState } from '@repo/storage-chrome/session';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import { createTxApprovalSlice, TxApprovalSlice } from './tx-approval';
import { createOriginApprovalSlice, OriginApprovalSlice } from './origin-approval';
import { ConnectedSitesSlice, createConnectedSitesSlice } from './connected-sites';
import { createDefaultFrontendSlice, DefaultFrontendSlice } from './default-frontend';
import { createNumerairesSlice, NumerairesSlice } from './numeraires';
import { createZignerSlice, ZignerSlice } from './zigner';
import { createZignerWalletsSlice, ZignerWalletsSlice } from './zigner-wallets';
import { createTradingModeSlice, TradingModeSlice } from './trading-mode';
import { createZignerSigningSlice, ZignerSigningSlice } from './zigner-signing';
import { createPrivacySlice, PrivacySlice } from './privacy';
import { createNetworksSlice, NetworksSlice } from './networks';
import { createKeyRingSlice, KeyRingSlice } from './keyring';

export interface AllSlices {
  wallets: WalletsSlice;
  password: PasswordSlice;
  seedPhrase: SeedPhraseSlice;
  network: NetworkSlice;
  activeNetwork: ActiveNetworkSlice;
  numeraires: NumerairesSlice;
  txApproval: TxApprovalSlice;
  originApproval: OriginApprovalSlice;
  connectedSites: ConnectedSitesSlice;
  defaultFrontend: DefaultFrontendSlice;
  zigner: ZignerSlice;
  zignerWallets: ZignerWalletsSlice;
  tradingMode: TradingModeSlice;
  zignerSigning: ZignerSigningSlice;
  privacy: PrivacySlice;
  networks: NetworksSlice;
  keyRing: KeyRingSlice;
}

export type SliceCreator<SliceInterface> = StateCreator<
  AllSlices,
  [['zustand/immer', never]],
  [],
  SliceInterface
>;

export const initializeStore = (
  session: ExtensionStorage<SessionStorageState>,
  local: ExtensionStorage<LocalStorageState>,
) => {
  return immer((setState, getState: () => AllSlices, store) => ({
    wallets: createWalletsSlice(session, local)(setState, getState, store),
    password: createPasswordSlice(session, local)(setState, getState, store),
    seedPhrase: createSeedPhraseSlice(setState, getState, store),
    network: createNetworkSlice(local)(setState, getState, store),
    activeNetwork: createActiveNetworkSlice(local)(setState, getState, store),
    numeraires: createNumerairesSlice(local)(setState, getState, store),
    connectedSites: createConnectedSitesSlice(local)(setState, getState, store),
    txApproval: createTxApprovalSlice(local)(setState, getState, store),
    originApproval: createOriginApprovalSlice()(setState, getState, store),
    defaultFrontend: createDefaultFrontendSlice(local)(setState, getState, store),
    zigner: createZignerSlice(local)(setState, getState, store),
    zignerWallets: createZignerWalletsSlice(local)(setState, getState, store),
    tradingMode: createTradingModeSlice(local)(setState, getState, store),
    zignerSigning: createZignerSigningSlice(setState, getState, store),
    privacy: createPrivacySlice(local)(setState, getState, store),
    networks: createNetworksSlice(local)(setState, getState, store),
    keyRing: createKeyRingSlice(session, local)(setState, getState, store),
  }));
};

// Wrap in logger() middleware if wanting to see store changes in console
export const useStore = create<AllSlices>()(
  customPersist(initializeStore(sessionExtStorage, localExtStorage)),
);
