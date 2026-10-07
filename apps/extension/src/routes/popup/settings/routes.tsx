import { Navigate, useLocation, useSearchParams, type RouteObject } from 'react-router-dom';
import { PopupPath } from '../paths';
import { screen } from '../route-modules';
import { IS_BETA_BUILD } from '../../../config/feature-flags';

// every settings screen is route-level lazy (see route-modules.ts): the router
// loads the chunk before committing, so the previous screen stays up meanwhile

/** a chain's node sheet, for the home "switch node" links (`?network=<id>`) */
const NODE_SCREENS: Record<string, PopupPath> = {
  zcash: PopupPath.SETTINGS_ZCASH_NETWORK,
  penumbra: PopupPath.SETTINGS_PENUMBRA_NETWORK,
};

/** the old networks menu: a chain's node sheet when asked for one, else where networks turn on */
const OldNetworks = () => {
  const [params] = useSearchParams();
  const node = NODE_SCREENS[params.get('network') ?? ''];
  return <Navigate replace to={node ? `${node}?sheet=node` : PopupPath.SETTINGS_DEVICES} />;
};

/** an old path into its new home, keeping its query (`?sheet=`, `?id=`) */
const Moved = ({ to }: { to: PopupPath }) => (
  <Navigate replace to={`${to}${useLocation().search}`} />
);

/** paths from before the six groups: saved back stacks and links still land */
const MOVED: Record<string, PopupPath> = {
  '/settings/privacy': PopupPath.SETTINGS_NETWORK,
  '/settings/privacy/home': PopupPath.SETTINGS_NETWORK,
  '/settings/privacy/connections': PopupPath.SETTINGS_CONNECTIONS,
  '/settings/networks/home': PopupPath.SETTINGS_DEVICES,
  '/settings/networks/all': PopupPath.SETTINGS_DEVICES,
  '/settings/security-backup': PopupPath.SETTINGS_SECURITY,
  '/settings/devices/all': PopupPath.SETTINGS_DEVICES,
};

const SCREENS: [PopupPath, Parameters<typeof screen>[0]][] = [
  [PopupPath.SETTINGS, 'settingsMain'],
  [PopupPath.SUBSCRIBE, 'subscribe'],
  [PopupPath.SETTINGS_SECURITY, 'settingsSecurityHome'],
  [PopupPath.SETTINGS_NETWORK, 'settingsNetwork'],
  [PopupPath.SETTINGS_ZCASH_NETWORK, 'settingsZcashNetwork'],
  [PopupPath.SETTINGS_PEOPLE, 'settingsPeople'],
  [PopupPath.SETTINGS_DISPLAY, 'settingsDisplay'],
  [PopupPath.SETTINGS_DEVICES, 'settingsDevicesHome'],
  [PopupPath.SETTINGS_CLEAR_CACHE, 'settingsClearCache'],
  [PopupPath.SETTINGS_CONNECTED_SITES, 'settingsConnectedSites'],
  [PopupPath.SETTINGS_RECOVERY_PASSPHRASE, 'settingsPassphrase'],
  // lists the paired zigner vaults; pairing goes through the one device scanner
  [PopupPath.SETTINGS_ZIGNER, 'settingsZigner'],
  [PopupPath.SETTINGS_CONNECT_DEVICE, 'settingsConnectDevice'],
  [PopupPath.SETTINGS_FEATURES, 'settingsFeatures'],
  [PopupPath.SETTINGS_WALLETS, 'settingsWallets'],
  [PopupPath.SETTINGS_ABOUT, 'settingsAbout'],
  [PopupPath.SETTINGS_MULTISIG, 'settingsMultisig'],
  [PopupPath.SETTINGS_MULTISIG_BACKUP, 'settingsMultisigBackup'],
  [PopupPath.SETTINGS_VOTING, 'settingsVoting'],
  [PopupPath.SETTINGS_ZCASHME, 'settingsZcashMe'],
  [PopupPath.SETTINGS_CHANGE_PASSWORD, 'settingsChangePassword'],
  [PopupPath.SETTINGS_ADD_VIEWING_KEY, 'settingsAddViewingKey'],
  [PopupPath.SETTINGS_PENUMBRA_NETWORK, 'settingsPenumbraNetwork'],
  [PopupPath.SETTINGS_REMOVE_WALLET, 'settingsRemoveWallet'],
  [PopupPath.SETTINGS_CONNECTIONS, 'settingsConnections'],
  [PopupPath.SETTINGS_CONTACTED, 'settingsContacted'],
];

export const settingsRoutes: RouteObject[] = [
  ...SCREENS.map(([path, id]) => ({ path, ...screen(id) })),
  { path: PopupPath.SETTINGS_NETWORKS, element: <OldNetworks /> },
  ...Object.entries(MOVED).map(([path, to]) => ({ path, element: <Moved to={to} /> })),
  {
    // device update fetches from a local dev stub (ota/keys.ts): beta only
    path: PopupPath.SETTINGS_OTA,
    ...(IS_BETA_BUILD
      ? screen('settingsOta')
      : { element: <Navigate replace to={PopupPath.SETTINGS_ZIGNER} /> }),
  },
];
