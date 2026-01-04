import { lazy, Suspense } from 'react';
import { createHashRouter, RouteObject } from 'react-router-dom';
import { PopupIndex, popupIndexLoader } from './home';
import { Login, popupLoginLoader } from './login';
import { PopupPath } from './paths';
import { PopupLayout } from './popup-layout';
import { settingsRoutes } from './settings/routes';

// lazy load heavier routes
const Settings = lazy(() => import('./settings').then(m => ({ default: m.Settings })));
const TransactionApproval = lazy(() =>
  import('./approval/transaction').then(m => ({ default: m.TransactionApproval })),
);
const OriginApproval = lazy(() =>
  import('./approval/origin').then(m => ({ default: m.OriginApproval })),
);

// suspense fallback for lazy routes
const LazyFallback = () => (
  <div className="flex h-full items-center justify-center">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  </div>
);

export const popupRoutes: RouteObject[] = [
  {
    element: <PopupLayout />,
    children: [
      {
        path: PopupPath.INDEX,
        element: <PopupIndex />,
        loader: popupIndexLoader,
      },
      {
        path: PopupPath.LOGIN,
        element: <Login />,
        loader: popupLoginLoader,
      },
      {
        path: PopupPath.SETTINGS,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <Settings />
          </Suspense>
        ),
        children: settingsRoutes,
      },
      {
        path: PopupPath.TRANSACTION_APPROVAL,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <TransactionApproval />
          </Suspense>
        ),
      },
      {
        path: PopupPath.ORIGIN_APPROVAL,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <OriginApproval />
          </Suspense>
        ),
      },
    ],
  },
];

export const popupRouter = createHashRouter(popupRoutes, {
  future: {
    v7_relativeSplatPath: true,
  } as { v7_relativeSplatPath: boolean },
});
