import type { ComponentType } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { AllSlices } from '../../state';

type Load = () => Promise<ComponentType>;

/**
 * Every lazily-loaded popup screen, in one place.
 *
 * The router's route-level `lazy` and the idle preloader both call these same
 * functions, so a path only ever lives here. Webpack caches each import(), so
 * a screen that was preloaded resolves immediately when navigated to.
 */
export const popupScreens = {
  // settings (layout + screens)
  settings: () => import('./settings').then(m => m.Settings),
  subscribe: () => import('./settings/subscribe').then(m => m.SubscribePage),
  settingsMain: () => import('./settings/settings').then(m => m.Settings),
  settingsClearCache: () =>
    import('./settings/settings-clear-cache').then(m => m.SettingsClearCache),
  settingsConnectedSites: () => import('./identity/sites').then(m => m.SitesPage),
  settingsPassphrase: () =>
    import('./settings/settings-passphrase').then(m => m.SettingsPassphrase),
  settingsWallets: () => import('./settings/settings-wallets').then(m => m.SettingsWallets),
  settingsNetwork: () => import('./settings/settings-network').then(m => m.SettingsNetwork),
  settingsPeople: () => import('./settings/settings-people').then(m => m.SettingsPeople),
  settingsDisplay: () => import('./settings/settings-display').then(m => m.SettingsDisplay),
  settingsContacted: () => import('./settings/settings-contacted').then(m => m.SettingsContacted),
  settingsFeatures: () => import('./settings/settings-features').then(m => m.SettingsFeatures),
  settingsChangePassword: () =>
    import('./settings/settings-change-password').then(m => m.SettingsChangePassword),
  forgotPassword: () => import('./forgot-password').then(m => m.ForgotPassword),
  settingsAddViewingKey: () =>
    import('./settings/settings-add-viewing-key').then(m => m.SettingsAddViewingKey),
  settingsAbout: () => import('./settings/settings-about').then(m => m.SettingsAbout),
  settingsMultisig: () => import('./settings/settings-multisig').then(m => m.SettingsMultisig),
  settingsMultisigBackup: () =>
    import('./settings/settings-multisig-backup').then(m => m.SettingsMultisigBackup),
  settingsZigner: () => import('./settings/settings-zigner').then(m => m.SettingsZigner),
  settingsConnectDevice: () =>
    import('./settings/settings-connect-device').then(m => m.SettingsConnectDevice),
  settingsOta: () => import('./settings/settings-ota').then(m => m.SettingsOta),
  settingsVoting: () => import('./settings/settings-voting').then(m => m.SettingsVoting),
  settingsZcashMe: () => import('./settings/settings-zcashme').then(m => m.SettingsZcashMe),

  // the settings group homes and the screens their rows need
  settingsSecurityHome: () =>
    import('./settings/settings-security-home').then(m => m.SettingsSecurityHome),
  settingsZcashNetwork: () =>
    import('./settings/settings-zcash-network').then(m => m.SettingsZcashNetwork),
  settingsPenumbraNetwork: () =>
    import('./settings/settings-penumbra-network').then(m => m.SettingsPenumbraNetwork),
  settingsDevicesHome: () =>
    import('./settings/settings-devices-home').then(m => m.SettingsDevicesHome),
  settingsRemoveWallet: () =>
    import('./settings/settings-remove-wallet').then(m => m.SettingsRemoveWallet),
  settingsConnections: () =>
    import('./settings/settings-connections').then(m => m.SettingsConnections),

  // approvals
  transactionApproval: () => import('./approval/transaction').then(m => m.TransactionApproval),
  originApproval: () => import('./approval/origin').then(m => m.OriginApproval),
  signApproval: () => import('./approval/sign').then(m => m.SignApproval),
  capabilityApproval: () => import('./approval/capability').then(m => m.CapabilityApproval),
  contactDiscoveryApproval: () =>
    import('./approval/contact-discovery').then(m => m.ContactDiscoveryApproval),
  destinationApproval: () => import('./approval/destination').then(m => m.DestinationApproval),
  passkeyApprove: () => import('./approval/passkey').then(m => m.PasskeyApprove),
  zcashSendApproval: () => import('./approval/zcash-send').then(m => m.ZcashSendApproval),
  keplrApproval: () => import('./approval/keplr').then(m => m.KeplrApproval),

  // tab pages and flows
  tools: () => import('./tools').then(m => m.ToolsPage),
  stake: () => import('./stake').then(m => m.StakePage),
  swap: () => import('./swap').then(m => m.SwapPage),
  vote: () => import('./vote').then(m => m.VotePage),
  inbox: () => import('./inbox').then(m => m.InboxPage),
  thread: () => import('./inbox/thread').then(m => m.ThreadPage),
  group: () => import('./inbox/group').then(m => m.GroupPage),
  groupInvite: () => import('./inbox/group-invite').then(m => m.GroupInvitePage),
  newGroup: () => import('./inbox/new-group').then(m => m.NewGroupPage),
  groupJoin: () => import('./inbox/group-join').then(m => m.GroupJoinPage),
  contacts: () => import('./contacts').then(m => m.ContactsPage),
  contact: () => import('./contacts/contact').then(m => m.ContactPage),
  contactCard: () => import('./contacts/card').then(m => m.CardPage),
  contactSeal: () => import('./contacts/seal').then(m => m.SealPage),
  addPerson: () => import('./inbox/add-person').then(m => m.AddPersonPage),
  scanCard: () => import('./inbox/scan-card').then(m => m.ScanCardPage),
  link: () => import('./link').then(m => m.LinkPage),
  send: () => import('./send').then(m => m.SendPage),
  receive: () => import('./receive').then(m => m.ReceivePage),
  cosmosSign: () => import('./cosmos-sign').then(m => m.CosmosSign),
  multisigSessions: () => import('./multisig/sessions').then(m => m.MultisigPage),
  multisigCreate: () => import('./multisig/create').then(m => m.MultisigCreate),
  multisigJoin: () => import('./multisig/join').then(m => m.MultisigJoin),
  multisigSign: () => import('./multisig/sign').then(m => m.MultisigSign),
  noteSync: () => import('./note-sync').then(m => m.NoteSyncPage),
  poolNotes: () => import('./pool-notes').then(m => m.PoolNotesPage),
  activity: () => import('./home/activity').then(m => m.ActivityPage),
  txDetail: () => import('./home/tx-detail').then(m => m.TxDetailPage),
  identity: () => import('./identity').then(m => m.IdentityPage),
  identitySites: () => import('./identity/sites').then(m => m.SitesPage),
  identityControls: () => import('./identity/controls').then(m => m.IdentityControlsPage),
  passwords: () => import('./identity/passwords').then(m => m.PasswordsPage),
  contactPicker: () => import('./pick-contacts').then(m => m.ContactPicker),
  frostApprove: () => import('./frost-approve').then(m => m.FrostApprove),
} satisfies Record<string, Load>;

export type PopupScreen = keyof typeof popupScreens;

/** what a route's preload is handed: the query cache, the store as it is now, the target's params */
export interface PreloadCtx {
  client: QueryClient;
  state: AllSlices;
  params: Readonly<Record<string, string | undefined>>;
  search: URLSearchParams;
}

/**
 * A route's data preload: warm the queries the screen will read, with the
 * keys it reads them by. Local reads (storage, IndexedDB, the zcash worker,
 * the view service) are free; the network only for a destination that is
 * already allowed and that the screen contacts the moment it opens - never an
 * egress ask, never a destination not yet allowed.
 */
export type Preload = (ctx: PreloadCtx) => unknown;

/** what a route declares in its `handle`: its chunk and its data */
export interface PreloadHandle {
  screen?: PopupScreen;
  preload?: Preload;
}

/**
 * A lazily loaded route: its chunk (route-level `lazy`, which the data router
 * resolves before it commits, so the current screen stays up until the next
 * one is ready) and, optionally, its data preload. Intent fires both.
 */
export const screen = (name: PopupScreen, preload?: Preload) => ({
  lazy: async () => ({ Component: await popupScreens[name]() }),
  handle: { screen: name, preload } satisfies PreloadHandle,
});

/** warm one screen's chunk; failures surface on navigation */
export const preloadScreen = (name: PopupScreen): void => {
  void popupScreens[name]().catch(() => undefined);
};

let preloadScheduled = false;

/**
 * The four bottom-tab roots (home has no chunk of its own: it is bundled
 * eagerly, not route-level lazy). Intent preloading (preload.ts) already
 * covers every other screen the moment a nav primitive is pressed or
 * hovered - warming all ~70 chunks here on every open would parse and
 * evaluate screens (settings, approvals, multisig, swap's icon registry...)
 * that a short-lived popup may never visit.
 */
const TAB_ROOT_SCREENS: readonly PopupScreen[] = ['inbox', 'tools', 'settings', 'settingsMain'];

/**
 * After first paint, import the tab roots in the background while the popup
 * is idle, so the four taps everyone makes resolve from cache. Idempotent
 * (StrictMode runs effects twice).
 */
export const schedulePreloadTabRoots = (): void => {
  if (preloadScheduled) {
    return;
  }
  preloadScheduled = true;
  const run = () => {
    for (const screen of TAB_ROOT_SCREENS) {
      preloadScreen(screen);
    }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 200);
  }
};
