import { createHashRouter, RouteObject } from 'react-router-dom';
import { RouteErrorScreen } from '../../components/error-boundary';
import { PopupIndex, popupIndexLoader } from './home';
import { lockedScreenGuard } from './popup-needs';
import { Login, popupLoginLoader } from './login';
import { PopupWelcome } from './welcome';
import { PopupPath } from './paths';
import { PopupLayout } from './popup-layout';
import { settingsRoutes } from './settings/routes';
import { IRONWOOD_MIGRATION } from '../../config/feature-flags';
import { lazyScreen } from './route-modules';

/**
 * Skeleton placeholder while the first screen hydrates (its loaders and its
 * route-level lazy chunk). Later navigations never show it: the router keeps
 * the current screen up until the next one has loaded.
 *
 * Spinner advertises "we're slow" - same wall-clock latency feels
 * slower to the user. A skeleton of plausible content geometry
 * (header strip + a couple of card-sized blocks) communicates
 * "loading layout you're about to see" instead. CSS pulse only, no
 * JS animation cost, no extra layout shift on resolution.
 */
const LazyFallback = () => (
  <div className='flex h-full flex-col gap-3 p-4 animate-pulse'>
    <div className='h-6 w-32 bg-elev-2/50' />
    <div className='h-24 w-full bg-elev-2/30' />
    <div className='h-16 w-full bg-elev-2/20' />
  </div>
);

export const popupRoutes: RouteObject[] = [
  {
    element: <PopupLayout />,
    // Root-level fallback shown while initial-hydration loaders (the INDEX and
    // LOGIN loaders below) resolve. Without it React Router 7 warns "No
    // HydrateFallback element provided to render during initial hydration".
    HydrateFallback: LazyFallback,
    // Catches throws from PopupLayout's own hooks (auto-sync, swap-claim, ...)
    // and replaces the whole view with a recoverable error screen.
    ErrorBoundary: RouteErrorScreen,
    children: [
      // Second tier: page/loader throws render INSIDE the layout Outlet, so the
      // tab chrome stays live and "go home" is one tap. Root boundary above
      // still covers layout-hook throws.
      {
        ErrorBoundary: RouteErrorScreen,
        // locked wallet -> unlock screen, for every screen that needs one
        loader: lockedScreenGuard,
        // re-check on every navigation, not only on first load
        shouldRevalidate: () => true,
        children: [
          // Main tabs
          {
            path: PopupPath.INDEX,
            element: <PopupIndex />,
            loader: popupIndexLoader,
          },
          {
            path: PopupPath.STAKE,
            lazy: lazyScreen('stake'),
          },
          {
            path: PopupPath.SWAP,
            lazy: lazyScreen('swap'),
          },
          {
            path: PopupPath.VOTE,
            lazy: lazyScreen('vote'),
          },
          {
            path: PopupPath.INBOX,
            lazy: lazyScreen('inbox'),
          },
          {
            path: PopupPath.INBOX_THREAD,
            lazy: lazyScreen('thread'),
          },
          {
            path: PopupPath.INBOX_GROUP,
            lazy: lazyScreen('groupChatThread'),
          },
          {
            path: PopupPath.CONTACTS,
            lazy: lazyScreen('contacts'),
          },
          {
            path: PopupPath.CONTACT,
            lazy: lazyScreen('contact'),
          },
          {
            path: PopupPath.TOOLS,
            lazy: lazyScreen('tools'),
          },
          {
            path: PopupPath.SETTINGS,
            lazy: lazyScreen('settings'),
            children: settingsRoutes,
          },

          // Identity
          {
            path: PopupPath.IDENTITY,
            lazy: lazyScreen('identity'),
          },
          {
            path: PopupPath.IDENTITY_SITES,
            lazy: lazyScreen('identitySites'),
          },
          {
            path: PopupPath.IDENTITY_CONTROLS,
            lazy: lazyScreen('identityControls'),
          },
          {
            path: PopupPath.PASSWORDS,
            lazy: lazyScreen('passwords'),
          },

          {
            path: PopupPath.LINK,
            lazy: lazyScreen('link'),
          },

          // Send/Receive
          {
            path: PopupPath.SEND,
            lazy: lazyScreen('send'),
          },
          {
            path: PopupPath.RECEIVE,
            lazy: lazyScreen('receive'),
          },

          // Cosmos airgap signing (dedicated window)
          {
            path: PopupPath.COSMOS_SIGN,
            lazy: lazyScreen('cosmosSign'),
          },

          // Multisig
          {
            path: PopupPath.MULTISIG,
            lazy: lazyScreen('multisigSessions'),
          },
          {
            path: PopupPath.MULTISIG_CREATE,
            lazy: lazyScreen('multisigCreate'),
          },
          {
            path: PopupPath.MULTISIG_JOIN,
            lazy: lazyScreen('multisigJoin'),
          },
          {
            path: PopupPath.MULTISIG_SIGN,
            lazy: lazyScreen('multisigSign'),
          },
          {
            path: PopupPath.NOTE_SYNC,
            lazy: lazyScreen('noteSync'),
          },
          {
            path: PopupPath.ACTIVITY,
            lazy: lazyScreen('activity'),
          },
          {
            path: PopupPath.TX_DETAIL,
            lazy: lazyScreen('txDetail'),
          },

          // Per-pool notes (orchard legacy vs ironwood). Registered only when the
          // IRONWOOD_MIGRATION flag is ON - the dual-pool UI is dormant otherwise.
          ...(IRONWOOD_MIGRATION
            ? [
                {
                  path: PopupPath.POOL_NOTES,
                  lazy: lazyScreen('poolNotes'),
                },
              ]
            : []),

          // zid contact picker (external app requests)
          {
            path: PopupPath.CONTACT_PICKER,
            lazy: lazyScreen('contactPicker'),
          },
          {
            path: PopupPath.FROST_APPROVE,
            lazy: lazyScreen('frostApprove'),
          },
          {
            path: PopupPath.PASSKEY_APPROVE,
            lazy: lazyScreen('passkeyApprove'),
          },

          // Auth
          {
            path: PopupPath.LOGIN,
            element: <Login />,
            loader: popupLoginLoader,
          },
          { path: PopupPath.WELCOME, element: <PopupWelcome /> },
          { path: PopupPath.FORGOT_PASSWORD, lazy: lazyScreen('forgotPassword') },

          // Approvals
          {
            path: PopupPath.TRANSACTION_APPROVAL,
            lazy: lazyScreen('transactionApproval'),
          },
          {
            path: PopupPath.ORIGIN_APPROVAL,
            lazy: lazyScreen('originApproval'),
          },
          {
            path: PopupPath.SIGN_APPROVAL,
            lazy: lazyScreen('signApproval'),
          },
          {
            path: PopupPath.CAPABILITY_APPROVAL,
            lazy: lazyScreen('capabilityApproval'),
          },
          {
            path: PopupPath.CONTACT_DISCOVERY_APPROVAL,
            lazy: lazyScreen('contactDiscoveryApproval'),
          },
          {
            path: PopupPath.DESTINATION_APPROVAL,
            lazy: lazyScreen('destinationApproval'),
          },
          {
            path: PopupPath.ZCASH_SEND_APPROVAL,
            lazy: lazyScreen('zcashSendApproval'),
          },
          {
            path: PopupPath.KEPLR_APPROVAL,
            lazy: lazyScreen('keplrApproval'),
          },
        ],
      },
    ],
  },
];

export const popupRouter = createHashRouter(popupRoutes);
