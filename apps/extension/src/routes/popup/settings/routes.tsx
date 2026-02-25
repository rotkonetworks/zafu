import { lazy, Suspense } from 'react';
import { PopupPath } from '../paths';

// lazy load all settings screens
const SettingsMain = lazy(() => import('./settings').then(m => ({ default: m.Settings })));
const SettingsClearCache = lazy(() =>
  import('./settings-clear-cache').then(m => ({ default: m.SettingsClearCache })),
);
const SettingsConnectedSites = lazy(() =>
  import('./settings-connected-sites').then(m => ({ default: m.SettingsConnectedSites })),
);
const SettingsPassphrase = lazy(() =>
  import('./settings-passphrase').then(m => ({ default: m.SettingsPassphrase })),
);
const SettingsRPC = lazy(() => import('./settings-rpc').then(m => ({ default: m.SettingsRPC })));
const SettingsDefaultFrontend = lazy(() =>
  import('./settings-default-frontend').then(m => ({ default: m.SettingsDefaultFrontend })),
);
const SettingsNumeraires = lazy(() =>
  import('./settings-numeraires').then(m => ({ default: m.SettingsNumeraires })),
);
const SettingsZigner = lazy(() =>
  import('./settings-zigner').then(m => ({ default: m.SettingsZigner })),
);
const SettingsNetworkEndpoints = lazy(() =>
  import('./settings-network-endpoints').then(m => ({ default: m.SettingsNetworkEndpoints })),
);
const SettingsNetworks = lazy(() =>
  import('./settings-networks').then(m => ({ default: m.SettingsNetworks })),
);
const SettingsParachains = lazy(() =>
  import('./settings-parachains').then(m => ({ default: m.SettingsParachains })),
);
const SettingsPrivacy = lazy(() =>
  import('./settings-privacy').then(m => ({ default: m.SettingsPrivacy })),
);
const SettingsAbout = lazy(() =>
  import('./settings-about').then(m => ({ default: m.SettingsAbout })),
);

const LazyFallback = () => (
  <div className="flex h-full items-center justify-center p-4">
    <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);

const withSuspense = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <Suspense fallback={<LazyFallback />}>
    <Component />
  </Suspense>
);

export const settingsRoutes = [
  {
    path: PopupPath.SETTINGS,
    element: withSuspense(SettingsMain),
  },
  {
    path: PopupPath.SETTINGS_RPC,
    element: withSuspense(SettingsRPC),
  },
  {
    path: PopupPath.SETTINGS_DEFAULT_FRONTEND,
    element: withSuspense(SettingsDefaultFrontend),
  },
  {
    path: PopupPath.SETTINGS_CLEAR_CACHE,
    element: withSuspense(SettingsClearCache),
  },
  {
    path: PopupPath.SETTINGS_CONNECTED_SITES,
    element: withSuspense(SettingsConnectedSites),
  },
  {
    path: PopupPath.SETTINGS_RECOVERY_PASSPHRASE,
    element: withSuspense(SettingsPassphrase),
  },
  {
    path: PopupPath.SETTINGS_NUMERAIRES,
    element: withSuspense(SettingsNumeraires),
  },
  {
    path: PopupPath.SETTINGS_ZIGNER,
    element: withSuspense(SettingsZigner),
  },
  {
    path: PopupPath.SETTINGS_NETWORK_ENDPOINTS,
    element: withSuspense(SettingsNetworkEndpoints),
  },
  {
    path: PopupPath.SETTINGS_NETWORKS,
    element: withSuspense(SettingsNetworks),
  },
  {
    path: PopupPath.SETTINGS_PARACHAINS,
    element: withSuspense(SettingsParachains),
  },
  {
    path: PopupPath.SETTINGS_PRIVACY,
    element: withSuspense(SettingsPrivacy),
  },
  {
    path: PopupPath.SETTINGS_ABOUT,
    element: withSuspense(SettingsAbout),
  },
];
