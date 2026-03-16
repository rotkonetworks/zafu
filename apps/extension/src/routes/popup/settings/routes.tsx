import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
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
const SettingsDefaultFrontend = lazy(() =>
  import('./settings-default-frontend').then(m => ({ default: m.SettingsDefaultFrontend })),
);
const SettingsNetworks = lazy(() =>
  import('./settings-networks').then(m => ({ default: m.SettingsNetworks })),
);
const SettingsPrivacy = lazy(() =>
  import('./settings-privacy').then(m => ({ default: m.SettingsPrivacy })),
);
const SettingsWallets = lazy(() =>
  import('./settings-wallets').then(m => ({ default: m.SettingsWallets })),
);
const SettingsAbout = lazy(() =>
  import('./settings-about').then(m => ({ default: m.SettingsAbout })),
);

const LazyFallback = () => (
  <div className="flex h-full items-center justify-center p-4">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
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
    path: PopupPath.SETTINGS_ZIGNER,
    element: <Navigate to={PopupPath.SETTINGS_WALLETS} replace />,
  },
  {
    path: PopupPath.SETTINGS_NETWORKS,
    element: withSuspense(SettingsNetworks),
  },
  {
    path: PopupPath.SETTINGS_PRIVACY,
    element: withSuspense(SettingsPrivacy),
  },
  {
    path: PopupPath.SETTINGS_WALLETS,
    element: withSuspense(SettingsWallets),
  },
  {
    path: PopupPath.SETTINGS_ABOUT,
    element: withSuspense(SettingsAbout),
  },
];
