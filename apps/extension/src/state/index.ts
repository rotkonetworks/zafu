import { create, StateCreator } from 'zustand';
import { createWalletsSlice, WalletsSlice } from './wallets';
import { immer } from 'zustand/middleware/immer';
import { customPersist } from './persist';
import { createPasswordSlice, PasswordSlice } from './password';
import { createSeedPhraseSlice, SeedPhraseSlice } from './seed-phrase';
import { createNetworkSlice, NetworkSlice } from './network';
import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage, type SessionStorageState } from '@repo/storage-chrome/session';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import { createEncryptedLocal } from './encrypted-storage';
import { createTxApprovalSlice, TxApprovalSlice } from './tx-approval';
import { createOriginApprovalSlice, OriginApprovalSlice } from './origin-approval';
import { ConnectedSitesSlice, createConnectedSitesSlice } from './connected-sites';
import { createDefaultFrontendSlice, DefaultFrontendSlice } from './default-frontend';
import { createNumerairesSlice, NumerairesSlice } from './numeraires';
import { createZignerSlice, ZignerSlice } from './zigner';
import { createTradingModeSlice, TradingModeSlice } from './trading-mode';
import { createZignerSigningSlice, ZignerSigningSlice } from './zigner-signing';
import { createPrivacySlice, PrivacySlice } from './privacy';
import { createNetworksSlice, NetworksSlice } from './networks';
import { createKeyRingSlice, KeyRingSlice } from './keyring';
import { createIbcWithdrawSlice, IbcWithdrawSlice } from './ibc-withdraw';
import { createPenumbraSendSlice, PenumbraSendSlice } from './penumbra-send';
import { createContactsSlice, ContactsSlice } from './contacts';
import { createMessagesSlice, MessagesSlice } from './messages';
import { createRecentAddressesSlice, RecentAddressesSlice } from './recent-addresses';
import { createSignApprovalSlice, SignApprovalSlice } from './sign-approval';
import { createFrostSessionSlice, FrostSessionSlice } from './frost-session';
import { createInboxSlice, InboxSlice } from './inbox';
import { createLicenseSlice, LicenseSlice } from './license';

export interface AllSlices {
  wallets: WalletsSlice;
  password: PasswordSlice;
  seedPhrase: SeedPhraseSlice;
  network: NetworkSlice;
  numeraires: NumerairesSlice;
  txApproval: TxApprovalSlice;
  originApproval: OriginApprovalSlice;
  connectedSites: ConnectedSitesSlice;
  defaultFrontend: DefaultFrontendSlice;
  zigner: ZignerSlice;
  tradingMode: TradingModeSlice;
  zignerSigning: ZignerSigningSlice;
  privacy: PrivacySlice;
  networks: NetworksSlice;
  keyRing: KeyRingSlice;
  ibcWithdraw: IbcWithdrawSlice;
  penumbraSend: PenumbraSendSlice;
  contacts: ContactsSlice;
  messages: MessagesSlice;
  recentAddresses: RecentAddressesSlice;
  signApproval: SignApprovalSlice;
  frostSession: FrostSessionSlice;
  inbox: InboxSlice;
  license: LicenseSlice;
}

export type SliceCreator<SliceInterface> = StateCreator<
  AllSlices,
  [['zustand/immer', never]],
  [],
  SliceInterface
>;

export const initializeStore = (
  session: ExtensionStorage<SessionStorageState>,
  rawLocal: ExtensionStorage<LocalStorageState>,
) => {
  // wrap local storage with encryption for sensitive keys
  // wallets, zcashWallets, contacts, messages, knownSites auto-encrypted
  const local = createEncryptedLocal(rawLocal, session);

  return immer((setState, getState: () => AllSlices, store) => ({
    wallets: createWalletsSlice(session, local)(setState, getState, store),
    password: createPasswordSlice(session, local)(setState, getState, store),
    seedPhrase: createSeedPhraseSlice(setState, getState, store),
    network: createNetworkSlice(local)(setState, getState, store),
    numeraires: createNumerairesSlice(local)(setState, getState, store),
    connectedSites: createConnectedSitesSlice(local)(setState, getState, store),
    txApproval: createTxApprovalSlice(local)(setState, getState, store),
    originApproval: createOriginApprovalSlice()(setState, getState, store),
    defaultFrontend: createDefaultFrontendSlice(local)(setState, getState, store),
    zigner: createZignerSlice(local)(setState, getState, store),
    tradingMode: createTradingModeSlice(local)(setState, getState, store),
    zignerSigning: createZignerSigningSlice(setState, getState, store),
    privacy: createPrivacySlice(local)(setState, getState, store),
    networks: createNetworksSlice(local)(setState, getState, store),
    keyRing: createKeyRingSlice(session, local)(setState, getState, store),
    ibcWithdraw: createIbcWithdrawSlice(setState, getState, store),
    penumbraSend: createPenumbraSendSlice(setState, getState, store),
    contacts: createContactsSlice(local, session)(setState, getState, store),
    messages: createMessagesSlice(local)(setState, getState, store),
    recentAddresses: createRecentAddressesSlice(local, session)(setState, getState, store),
    signApproval: createSignApprovalSlice()(setState, getState, store),
    frostSession: createFrostSessionSlice()(setState, getState, store),
    inbox: createInboxSlice()(setState, getState, store),
    license: createLicenseSlice()(setState, getState, store),
  }));
};

// Wrap in logger() middleware if wanting to see store changes in console
export const useStore = create<AllSlices>()(
  customPersist(initializeStore(sessionExtStorage, localExtStorage)),
);

/** store type for use in test mocks — includes immer middleware signature */
export type TestStore = typeof useStore;
