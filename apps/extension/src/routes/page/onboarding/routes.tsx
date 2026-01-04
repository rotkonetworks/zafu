import { lazy, Suspense } from 'react';
import { PagePath } from '../paths';

// lazy load all onboarding screens
const OnboardingStart = lazy(() => import('./start').then(m => ({ default: m.OnboardingStart })));
const GenerateSeedPhrase = lazy(() =>
  import('./generate').then(m => ({ default: m.GenerateSeedPhrase })),
);
const ImportSeedPhrase = lazy(() =>
  import('./import').then(m => ({ default: m.ImportSeedPhrase })),
);
const ImportZigner = lazy(() => import('./import-zigner').then(m => ({ default: m.ImportZigner })));
const SetPassword = lazy(() => import('./password').then(m => ({ default: m.SetPassword })));
const OnboardingSuccess = lazy(() =>
  import('./success').then(m => ({ default: m.OnboardingSuccess })),
);

const LazyFallback = () => (
  <div className="flex h-full items-center justify-center">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);

const withSuspense = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <Suspense fallback={<LazyFallback />}>
    <Component />
  </Suspense>
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
    path: PagePath.SET_PASSWORD,
    element: withSuspense(SetPassword),
  },
  {
    path: PagePath.ONBOARDING_SUCCESS,
    element: withSuspense(OnboardingSuccess),
  },
];
