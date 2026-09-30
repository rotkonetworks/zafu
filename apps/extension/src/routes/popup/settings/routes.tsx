import type { RouteObject } from 'react-router-dom';
import { PopupPath } from '../paths';
import { lazyScreen } from '../route-modules';

// every settings screen is route-level lazy (see route-modules.ts): the router
// loads the chunk before committing, so the previous screen stays up meanwhile

export const settingsRoutes: RouteObject[] = [
  {
    path: PopupPath.SETTINGS,
    lazy: lazyScreen('settingsMain'),
  },
  {
    path: PopupPath.SUBSCRIBE,
    lazy: lazyScreen('subscribe'),
  },
  {
    path: PopupPath.SETTINGS_DEFAULT_FRONTEND,
    lazy: lazyScreen('settingsDefaultFrontend'),
  },
  {
    path: PopupPath.SETTINGS_CLEAR_CACHE,
    lazy: lazyScreen('settingsClearCache'),
  },
  {
    path: PopupPath.SETTINGS_CONNECTED_SITES,
    lazy: lazyScreen('settingsConnectedSites'),
  },
  {
    path: PopupPath.SETTINGS_RECOVERY_PASSPHRASE,
    lazy: lazyScreen('settingsPassphrase'),
  },
  {
    // real zigner screen - a "zigner" link that silently redirected to the
    // wallets list made the label lie. wallets still handles vault import;
    // this screen owns zigner-specific settings (vault legacy mode, scan).
    path: PopupPath.SETTINGS_ZIGNER,
    lazy: lazyScreen('settingsZigner'),
  },
  {
    // networks deep-links (?network=zcash) still land here; the merged screen
    // keeps the ?network auto-expand + scroll-into-view.
    path: PopupPath.SETTINGS_NETWORKS,
    lazy: lazyScreen('settingsWalletsNetworks'),
  },
  {
    path: PopupPath.SETTINGS_PRIVACY,
    lazy: lazyScreen('settingsPrivacy'),
  },
  {
    path: PopupPath.SETTINGS_FEATURES,
    lazy: lazyScreen('settingsFeatures'),
  },
  {
    path: PopupPath.SETTINGS_APPEARANCE,
    lazy: lazyScreen('settingsAppearance'),
  },
  {
    path: PopupPath.SETTINGS_WALLETS,
    lazy: lazyScreen('settingsWalletsNetworks'),
  },
  {
    path: PopupPath.SETTINGS_SECURITY_BACKUP,
    lazy: lazyScreen('settingsSecurityBackup'),
  },
  {
    path: PopupPath.SETTINGS_ABOUT,
    lazy: lazyScreen('settingsAbout'),
  },
  {
    path: PopupPath.SETTINGS_MULTISIG,
    lazy: lazyScreen('settingsMultisig'),
  },
  {
    path: PopupPath.SETTINGS_MULTISIG_BACKUP,
    lazy: lazyScreen('settingsMultisigBackup'),
  },
  {
    path: PopupPath.SETTINGS_OTA,
    lazy: lazyScreen('settingsOta'),
  },
  {
    path: PopupPath.SETTINGS_VOTING,
    lazy: lazyScreen('settingsVoting'),
  },
  {
    path: PopupPath.SETTINGS_ZCASHME,
    lazy: lazyScreen('settingsZcashMe'),
  },
  {
    path: PopupPath.SETTINGS_ADD_VIEWING_KEY,
    lazy: lazyScreen('settingsAddViewingKey'),
  },
  {
    path: PopupPath.SETTINGS_SECURITY,
    lazy: lazyScreen('settingsSecurityHome'),
  },
  {
    path: PopupPath.SETTINGS_PRIVACY_HOME,
    lazy: lazyScreen('settingsPrivacyHome'),
  },
  {
    path: PopupPath.SETTINGS_NETWORKS_HOME,
    lazy: lazyScreen('settingsNetworksHome'),
  },
  {
    path: PopupPath.SETTINGS_ZCASH_NETWORK,
    lazy: lazyScreen('settingsZcashNetwork'),
  },
  {
    path: PopupPath.SETTINGS_DEVICES,
    lazy: lazyScreen('settingsDevicesHome'),
  },
  {
    path: PopupPath.SETTINGS_DEVICES_ALL,
    lazy: lazyScreen('settingsDevicesAll'),
  },
  {
    path: PopupPath.SETTINGS_REMOVE_WALLET,
    lazy: lazyScreen('settingsRemoveWallet'),
  },
  {
    path: PopupPath.SETTINGS_CONNECTIONS,
    lazy: lazyScreen('settingsConnections'),
  },
];
