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
import { screen, type PreloadHandle } from './route-modules';
import { routePreloads } from './route-preloads';
import { registerRoutePreload } from './preload';
import { BUY_PRELOAD, preloadBuyPage } from '../../buy/open';
import { LP_PRELOAD, preloadLpPage } from '../../lp/open';
import { startNym } from '../../net/nym-bridge';

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
            handle: { preload: routePreloads.home } satisfies PreloadHandle,
          },
          {
            path: PopupPath.STAKE,
            ...screen('stake'),
          },
          {
            path: PopupPath.SWAP,
            ...screen('swap', routePreloads.swap),
          },
          {
            path: PopupPath.VOTE,
            ...screen('vote'),
          },
          {
            path: PopupPath.INBOX,
            ...screen('inbox'),
          },
          {
            path: PopupPath.INBOX_THREAD,
            ...screen('thread'),
          },
          {
            path: PopupPath.INBOX_GROUP,
            ...screen('group'),
          },
          {
            path: PopupPath.INBOX_GROUP_INVITE,
            ...screen('groupInvite'),
          },
          {
            path: PopupPath.INBOX_NEW_GROUP,
            ...screen('newGroup'),
          },
          {
            path: PopupPath.INBOX_JOIN,
            ...screen('groupJoin'),
          },
          {
            path: PopupPath.INBOX_ADD,
            ...screen('addPerson'),
          },
          {
            path: PopupPath.INBOX_SCAN,
            ...screen('scanCard'),
          },
          {
            path: PopupPath.CONTACTS,
            ...screen('contacts'),
          },
          {
            path: PopupPath.CONTACT_CARD,
            ...screen('contactCard'),
          },
          {
            path: PopupPath.CONTACT_SEAL,
            ...screen('contactSeal'),
          },
          {
            path: PopupPath.CONTACT,
            ...screen('contact'),
          },
          {
            path: PopupPath.TOOLS,
            ...screen('tools'),
          },
          {
            path: PopupPath.SETTINGS,
            ...screen('settings'),
            children: settingsRoutes,
          },

          // Identity
          {
            path: PopupPath.IDENTITY,
            ...screen('identity', routePreloads.identity),
          },
          {
            path: PopupPath.IDENTITY_SITES,
            ...screen('identitySites'),
          },
          {
            path: PopupPath.IDENTITY_CONTROLS,
            ...screen('identityControls'),
          },
          {
            path: PopupPath.PASSWORDS,
            ...screen('passwords'),
          },

          {
            path: PopupPath.LINK,
            ...screen('link'),
          },

          // Send/Receive
          {
            path: PopupPath.SEND,
            ...screen('send', routePreloads.send),
          },
          {
            path: PopupPath.RECEIVE,
            ...screen('receive', routePreloads.receive),
          },

          // Cosmos airgap signing (dedicated window)
          {
            path: PopupPath.COSMOS_SIGN,
            ...screen('cosmosSign'),
          },

          // Multisig
          {
            path: PopupPath.MULTISIG,
            ...screen('multisigSessions'),
          },
          {
            path: PopupPath.MULTISIG_CREATE,
            ...screen('multisigCreate'),
          },
          {
            path: PopupPath.MULTISIG_JOIN,
            ...screen('multisigJoin'),
          },
          {
            path: PopupPath.MULTISIG_SIGN,
            ...screen('multisigSign'),
          },
          {
            path: PopupPath.NOTE_SYNC,
            ...screen('noteSync'),
          },
          {
            path: PopupPath.ACTIVITY,
            ...screen('activity', routePreloads.activity),
          },
          {
            path: PopupPath.TX_DETAIL,
            ...screen('txDetail'),
          },

          // Per-pool notes (orchard legacy vs ironwood). Registered only when the
          // IRONWOOD_MIGRATION flag is ON - the dual-pool UI is dormant otherwise.
          ...(IRONWOOD_MIGRATION
            ? [
                {
                  path: PopupPath.POOL_NOTES,
                  ...screen('poolNotes'),
                },
              ]
            : []),

          // zid contact picker (external app requests)
          {
            path: PopupPath.CONTACT_PICKER,
            ...screen('contactPicker'),
          },
          {
            path: PopupPath.FROST_APPROVE,
            ...screen('frostApprove'),
          },
          {
            path: PopupPath.PASSKEY_APPROVE,
            ...screen('passkeyApprove'),
          },

          // Auth
          {
            path: PopupPath.LOGIN,
            element: <Login />,
            loader: popupLoginLoader,
          },
          { path: PopupPath.WELCOME, element: <PopupWelcome /> },
          { path: PopupPath.FORGOT_PASSWORD, ...screen('forgotPassword') },

          // Approvals
          {
            path: PopupPath.TRANSACTION_APPROVAL,
            ...screen('transactionApproval'),
          },
          {
            path: PopupPath.ORIGIN_APPROVAL,
            ...screen('originApproval'),
          },
          {
            path: PopupPath.SIGN_APPROVAL,
            ...screen('signApproval'),
          },
          {
            path: PopupPath.CAPABILITY_APPROVAL,
            ...screen('capabilityApproval'),
          },
          {
            path: PopupPath.CONTACT_DISCOVERY_APPROVAL,
            ...screen('contactDiscoveryApproval'),
          },
          {
            path: PopupPath.DESTINATION_APPROVAL,
            ...screen('destinationApproval'),
          },
          {
            path: PopupPath.ZCASH_SEND_APPROVAL,
            ...screen('zcashSendApproval'),
          },
          {
            path: PopupPath.KEPLR_APPROVAL,
            ...screen('keplrApproval'),
          },
        ],
      },
    ],
  },
];

// targets that are not routes: the wallets panel opens over any screen
registerRoutePreload('sheet:wallets', routePreloads.wallets);
// buy.html opens in its own tab: intent on a buy entry warms its code, never its data
registerRoutePreload(BUY_PRELOAD, preloadBuyPage);
// lp.html likewise: its code, never a read of the pool
registerRoutePreload(LP_PRELOAD, preloadLpPage);
// a send is coming: start nym on intent, so its cold start overlaps the form
for (const target of [PopupPath.SEND, PopupPath.SWAP, LP_PRELOAD]) {
  registerRoutePreload(target, startNym);
}

export const popupRouter = createHashRouter(popupRoutes);
