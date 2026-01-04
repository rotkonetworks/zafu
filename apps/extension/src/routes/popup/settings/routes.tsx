import { lazy, Suspense } from 'react';
import { PopupPath } from '../paths';

// lazy load all settings screens
const SettingsMain = lazy(() => import('./settings').then(m => ({ default: m.Settings })));
const SettingsAdvanced = lazy(() =>
  import('./settings-advanced').then(m => ({ default: m.SettingsAdvanced })),
);
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
    path: PopupPath.SETTINGS_ADVANCED,
    element: withSuspense(SettingsAdvanced),
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
];
