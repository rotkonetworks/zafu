import { Navigate, type RouteObject } from 'react-router-dom';
import { PopupPath } from '../paths';
import { screen } from '../route-modules';
import { IS_BETA_BUILD } from '../../../config/feature-flags';

// every settings screen is route-level lazy (see route-modules.ts): the router
// loads the chunk before committing, so the previous screen stays up meanwhile

export const settingsRoutes: RouteObject[] = [
  {
    path: PopupPath.SETTINGS,
    ...screen('settingsMain'),
  },
  {
    path: PopupPath.SUBSCRIBE,
    ...screen('subscribe'),
  },
  {
    path: PopupPath.SETTINGS_CLEAR_CACHE,
    ...screen('settingsClearCache'),
  },
  {
    path: PopupPath.SETTINGS_CONNECTED_SITES,
    ...screen('settingsConnectedSites'),
  },
  {
    path: PopupPath.SETTINGS_RECOVERY_PASSPHRASE,
    ...screen('settingsPassphrase'),
  },
  {
    // real zigner screen - a "zigner" link that silently redirected to the
    // wallets list made the label lie. it lists the paired zigner vaults;
    // pairing goes through the one device scanner (connect-device).
    path: PopupPath.SETTINGS_ZIGNER,
    ...screen('settingsZigner'),
  },
  {
    path: PopupPath.SETTINGS_CONNECT_DEVICE,
    ...screen('settingsConnectDevice'),
  },
  {
    // ?network=zcash|penumbra (the home "switch node" links) opens that network's node sheet
    path: PopupPath.SETTINGS_NETWORKS,
    ...screen('settingsNetworks'),
  },
  // the old two-level networks menu; kept so saved back stacks still land
  ...['/settings/networks/home', '/settings/networks/all'].map(path => ({
    path,
    element: <Navigate replace to={PopupPath.SETTINGS_NETWORKS} />,
  })),
  // security, privacy and devices went through the same flattening: each
  // category is one screen now, so its old "all controls" (or home) path
  // just redirects to the category screen.
  {
    path: '/settings/security-backup',
    element: <Navigate replace to={PopupPath.SETTINGS_SECURITY} />,
  },
  {
    path: '/settings/privacy/home',
    element: <Navigate replace to={PopupPath.SETTINGS_PRIVACY} />,
  },
  {
    path: '/settings/devices/all',
    element: <Navigate replace to={PopupPath.SETTINGS_DEVICES} />,
  },
  {
    path: PopupPath.SETTINGS_PRIVACY,
    ...screen('settingsPrivacy'),
  },
  {
    path: PopupPath.SETTINGS_FEATURES,
    ...screen('settingsFeatures'),
  },
  {
    path: PopupPath.SETTINGS_WALLETS,
    ...screen('settingsWalletsNetworks'),
  },
  {
    path: PopupPath.SETTINGS_ABOUT,
    ...screen('settingsAbout'),
  },
  {
    path: PopupPath.SETTINGS_MULTISIG,
    ...screen('settingsMultisig'),
  },
  {
    path: PopupPath.SETTINGS_MULTISIG_BACKUP,
    ...screen('settingsMultisigBackup'),
  },
  {
    // device update fetches from a local dev stub (ota/keys.ts): beta only
    path: PopupPath.SETTINGS_OTA,
    ...(IS_BETA_BUILD
      ? screen('settingsOta')
      : { element: <Navigate replace to={PopupPath.SETTINGS_DEVICES} /> }),
  },
  {
    path: PopupPath.SETTINGS_VOTING,
    ...screen('settingsVoting'),
  },
  {
    path: PopupPath.SETTINGS_ZCASHME,
    ...screen('settingsZcashMe'),
  },
  {
    path: PopupPath.SETTINGS_CHANGE_PASSWORD,
    ...screen('settingsChangePassword'),
  },
  {
    path: PopupPath.SETTINGS_ADD_VIEWING_KEY,
    ...screen('settingsAddViewingKey'),
  },
  {
    path: PopupPath.SETTINGS_SECURITY,
    ...screen('settingsSecurityHome'),
  },
  {
    path: PopupPath.SETTINGS_ZCASH_NETWORK,
    ...screen('settingsZcashNetwork'),
  },
  {
    path: PopupPath.SETTINGS_PENUMBRA_NETWORK,
    ...screen('settingsPenumbraNetwork'),
  },
  {
    path: PopupPath.SETTINGS_DEVICES,
    ...screen('settingsDevicesHome'),
  },
  {
    path: PopupPath.SETTINGS_REMOVE_WALLET,
    ...screen('settingsRemoveWallet'),
  },
  {
    path: PopupPath.SETTINGS_CONNECTIONS,
    ...screen('settingsConnections'),
  },
];
