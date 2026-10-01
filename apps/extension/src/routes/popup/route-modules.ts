import type { ComponentType } from 'react';

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
  settingsMain: () => import('./settings/settings').then(m => m.Settings),
  settingsClearCache: () =>
    import('./settings/settings-clear-cache').then(m => m.SettingsClearCache),
  settingsConnectedSites: () =>
    import('./settings/settings-connected-sites').then(m => m.SettingsConnectedSites),
  settingsPassphrase: () =>
    import('./settings/settings-passphrase').then(m => m.SettingsPassphrase),
  settingsDefaultFrontend: () =>
    import('./settings/settings-default-frontend').then(m => m.SettingsDefaultFrontend),
  settingsWalletsNetworks: () =>
    import('./settings/settings-wallets-networks').then(m => m.SettingsWalletsNetworks),
  settingsPrivacy: () => import('./settings/settings-privacy').then(m => m.SettingsPrivacy),
  settingsFeatures: () => import('./settings/settings-features').then(m => m.SettingsFeatures),
  settingsChangePassword: () =>
    import('./settings/settings-change-password').then(m => m.SettingsChangePassword),
  forgotPassword: () => import('./forgot-password').then(m => m.ForgotPassword),
  settingsAddViewingKey: () =>
    import('./settings/settings-add-viewing-key').then(m => m.SettingsAddViewingKey),
  // Security & Backup tab. SecurityBackup (authored by another engineer) brings
  // its own SettingsScreen chrome, so mount it directly - no extra wrapper.
  settingsSecurityBackup: () =>
    import('./settings/settings-security-backup').then(m => m.SecurityBackup),
  settingsAbout: () => import('./settings/settings-about').then(m => m.SettingsAbout),
  settingsMultisig: () => import('./settings/settings-multisig').then(m => m.SettingsMultisig),
  settingsMultisigBackup: () =>
    import('./settings/settings-multisig-backup').then(m => m.SettingsMultisigBackup),
  settingsZigner: () => import('./settings/settings-zigner').then(m => m.SettingsZigner),
  settingsOta: () => import('./settings/settings-ota').then(m => m.SettingsOta),
  settingsVoting: () => import('./settings/settings-voting').then(m => m.SettingsVoting),
  settingsZcashMe: () => import('./settings/settings-zcashme').then(m => m.SettingsZcashMe),
  subscribe: () => import('./settings/subscribe').then(m => m.SubscribePage),

  // four category homes (settings IA rework) + the screens their rows need
  settingsSecurityHome: () =>
    import('./settings/settings-security-home').then(m => m.SettingsSecurityHome),
  settingsPrivacyHome: () =>
    import('./settings/settings-privacy-home').then(m => m.SettingsPrivacyHome),
  settingsNetworks: () => import('./settings/settings-networks').then(m => m.SettingsNetworks),
  settingsZcashNetwork: () =>
    import('./settings/settings-zcash-network').then(m => m.SettingsZcashNetwork),
  settingsPenumbraNetwork: () =>
    import('./settings/settings-penumbra-network').then(m => m.SettingsPenumbraNetwork),
  settingsDevicesHome: () =>
    import('./settings/settings-devices-home').then(m => m.SettingsDevicesHome),
  settingsDevicesAll: () =>
    import('./settings/settings-devices-all').then(m => m.SettingsDevicesAll),
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
  groupChatThread: () => import('./inbox/group-chat-thread').then(m => m.GroupChatThread),
  contacts: () => import('./contacts').then(m => m.ContactsPage),
  send: () => import('./send').then(m => m.SendPage),
  receive: () => import('./receive').then(m => m.ReceivePage),
  injective: () => import('./injective').then(m => m.InjectivePage),
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
  passwords: () => import('./identity/passwords').then(m => m.PasswordsPage),
  contactPicker: () => import('./pick-contacts').then(m => m.ContactPicker),
  frostApprove: () => import('./frost-approve').then(m => m.FrostApprove),
} satisfies Record<string, Load>;

export type PopupScreen = keyof typeof popupScreens;

/**
 * Route-level `lazy` for a screen. The data router resolves it before it
 * commits the navigation, so the current screen stays up until the next one
 * is ready - no Suspense fallback flash in between.
 */
export const lazyScreen = (screen: PopupScreen) => async () => ({
  Component: await popupScreens[screen](),
});

/** warm one screen's chunk (e.g. on pointerdown); failures surface on navigation */
export const preloadScreen = (screen: PopupScreen): void => {
  void popupScreens[screen]().catch(() => undefined);
};

let preloadScheduled = false;

/**
 * After first paint, import every screen in the background while the popup is
 * idle. They are local extension files, so this is cheap, and it makes first
 * visits as instant as repeat ones. Idempotent (StrictMode runs effects twice).
 */
export const schedulePreloadAllScreens = (): void => {
  if (preloadScheduled) {
    return;
  }
  preloadScheduled = true;
  const run = () => {
    for (const screen of Object.keys(popupScreens) as PopupScreen[]) {
      preloadScreen(screen);
    }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2000 });
  } else {
    setTimeout(run, 200);
  }
};
