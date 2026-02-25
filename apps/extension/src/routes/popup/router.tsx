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

// lazy load tab pages
const StakePage = lazy(() => import('./stake').then(m => ({ default: m.StakePage })));
const SwapPage = lazy(() => import('./swap').then(m => ({ default: m.SwapPage })));
const HistoryPage = lazy(() => import('./history').then(m => ({ default: m.HistoryPage })));
const InboxPage = lazy(() => import('./inbox').then(m => ({ default: m.InboxPage })));
const ContactsPage = lazy(() => import('./contacts').then(m => ({ default: m.ContactsPage })));
const SendPage = lazy(() => import('./send').then(m => ({ default: m.SendPage })));
const ReceivePage = lazy(() => import('./receive').then(m => ({ default: m.ReceivePage })));
const CosmosSign = lazy(() => import('./cosmos-sign').then(m => ({ default: m.CosmosSign })));

// suspense fallback for lazy routes
const LazyFallback = () => (
  <div className='flex h-full items-center justify-center'>
    <div className='h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent' />
  </div>
);

export const popupRoutes: RouteObject[] = [
  {
    element: <PopupLayout />,
    children: [
      // Main tabs
      {
        path: PopupPath.INDEX,
        element: <PopupIndex />,
        loader: popupIndexLoader,
      },
      {
        path: PopupPath.STAKE,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <StakePage />
          </Suspense>
        ),
      },
      {
        path: PopupPath.SWAP,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <SwapPage />
          </Suspense>
        ),
      },
      {
        path: PopupPath.HISTORY,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <HistoryPage />
          </Suspense>
        ),
      },
      {
        path: PopupPath.INBOX,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <InboxPage />
          </Suspense>
        ),
      },
      {
        path: PopupPath.CONTACTS,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <ContactsPage />
          </Suspense>
        ),
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

      // Send/Receive
      {
        path: PopupPath.SEND,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <SendPage />
          </Suspense>
        ),
      },
      {
        path: PopupPath.RECEIVE,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <ReceivePage />
          </Suspense>
        ),
      },

      // Cosmos airgap signing (dedicated window)
      {
        path: PopupPath.COSMOS_SIGN,
        element: (
          <Suspense fallback={<LazyFallback />}>
            <CosmosSign />
          </Suspense>
        ),
      },

      // Auth
      {
        path: PopupPath.LOGIN,
        element: <Login />,
        loader: popupLoginLoader,
      },

      // Approvals
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
