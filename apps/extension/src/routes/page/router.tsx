import { lazy, Suspense } from 'react';
import { createHashRouter, Outlet, RouteObject } from 'react-router-dom';
import { RouteErrorScreen } from '../../components/error-boundary';
import { PageIndex, pageIndexLoader } from '.';
import { onboardingRoute } from './onboarding/routes';
import { PagePath } from './paths';

const GrantCamera = lazy(() => import('./grant-camera').then(m => ({ default: m.GrantCamera })));

// suspense fallback
const LazyFallback = () => (
  <div className='flex h-full items-center justify-center'>
    <div className='h-6 w-6 animate-spin border-2 border-primary border-t-transparent' />
  </div>
);

export const pageRoutes: RouteObject[] = [
  {
    element: <Outlet />,
    // Fallback while the initial-hydration INDEX loader resolves - avoids RR7's
    // "No HydrateFallback element provided to render during initial hydration".
    HydrateFallback: LazyFallback,
    // Recoverable error screen for loader/render throws (incl. lazy-chunk 404s
    // after an MV3 auto-update) instead of React Router's bare default screen.
    ErrorBoundary: RouteErrorScreen,
    children: [
      {
        path: PagePath.INDEX,
        element: <PageIndex />,
        loader: pageIndexLoader,
      },
      onboardingRoute,
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

export const pageRouter = createHashRouter(pageRoutes);
