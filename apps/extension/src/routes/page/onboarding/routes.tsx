import { lazy, Suspense } from 'react';
import { PagePath } from '../paths';
import { OnboardingShell } from './onboarding-shell';

// lazy load all onboarding screens
const OnboardingStart = lazy(() => import('./start').then(m => ({ default: m.OnboardingStart })));
const GenerateSeedPhrase = lazy(() =>
  import('./generate').then(m => ({ default: m.GenerateSeedPhrase })),
);
const ImportSeedPhrase = lazy(() =>
  import('./import').then(m => ({ default: m.ImportSeedPhrase })),
);
const ImportZigner = lazy(() => import('./import-zigner').then(m => ({ default: m.ImportZigner })));
const SelectNetworks = lazy(() =>
  import('./select-networks').then(m => ({ default: m.SelectNetworks })),
);
const SetPassword = lazy(() => import('./password').then(m => ({ default: m.SetPassword })));
const OnboardingSuccess = lazy(() =>
  import('./success').then(m => ({ default: m.OnboardingSuccess })),
);

/**
 * Skeleton placeholder used while a lazy route bundle is fetched. Avoids
 * the spinner because spinners advertise "we're slow" — a skeleton with
 * the same geometry as the real content feels faster even though the
 * wall-clock latency is identical. Pure CSS, no JS animation cost.
 */
const LazyFallback = () => (
  <div className='flex h-full flex-col gap-4 animate-pulse'>
    <div className='h-6 w-40 rounded-sm bg-elev-2/60' />
    <div className='h-3 w-64 rounded-sm bg-elev-2/40' />
    <div className='mt-4 h-32 w-full rounded-sm bg-elev-2/30' />
  </div>
);

const withSuspense = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <OnboardingShell>
    <Suspense fallback={<LazyFallback />}>
      <Component />
    </Suspense>
  </OnboardingShell>
);

export const onboardingRoutes = [
  {
    path: PagePath.WELCOME,
    element: withSuspense(OnboardingStart),
  },
  {
    path: PagePath.GENERATE_SEED_PHRASE,
    element: withSuspense(GenerateSeedPhrase),
  },
  {
    path: PagePath.IMPORT_SEED_PHRASE,
    element: withSuspense(ImportSeedPhrase),
  },
  {
    path: PagePath.IMPORT_ZIGNER,
    element: withSuspense(ImportZigner),
  },
  {
    path: PagePath.SELECT_NETWORKS,
    element: withSuspense(SelectNetworks),
  },
  {
    path: PagePath.SET_PASSWORD,
    element: withSuspense(SetPassword),
  },
  {
    path: PagePath.ONBOARDING_SUCCESS,
    element: withSuspense(OnboardingSuccess),
  },
];
