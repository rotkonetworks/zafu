import { lazy, Suspense } from 'react';
import { createHashRouter, Outlet, RouteObject } from 'react-router-dom';
import { PageIndex, pageIndexLoader } from '.';
import { onboardingRoutes } from './onboarding/routes';
import { PagePath } from './paths';

// lazy load onboarding flow (only needed once per install)
const Onboarding = lazy(() => import('./onboarding').then(m => ({ default: m.Onboarding })));
const GrantCamera = lazy(() => import('./grant-camera').then(m => ({ default: m.GrantCamera })));

// suspense fallback
const LazyFallback = () => (
  <div className="flex h-full items-center justify-center">
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);

export const pageRoutes: RouteObject[] = [
  {
    element: <Outlet />,
    children: [
      {
        path: PagePath.INDEX,
        element: <PageIndex />,
        loader: pageIndexLoader,
      },
      {
        path: PagePath.WELCOME,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <Onboarding />
          </Suspense>
        ),
        children: onboardingRoutes,
      },
      {
        path: PagePath.GRANT_CAMERA,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <GrantCamera />
          </Suspense>
        ),
      },
    ],
  },
];

export const pageRouter = createHashRouter(pageRoutes, {
  future: {
    v7_relativeSplatPath: true,
  } as { v7_relativeSplatPath: boolean },
});
