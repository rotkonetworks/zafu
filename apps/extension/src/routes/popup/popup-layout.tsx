import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { usePopupReady } from '../../hooks/popup-ready';
import { useSidePanelDelivery } from '../../hooks/side-panel-delivery';
import { useZcashAutoSync } from '../../hooks/zcash-auto-sync';
import { usePenumbraSwapClaim } from '../../hooks/penumbra-swap-claim';
import { BottomTabs, BOTTOM_TABS_HEIGHT } from '../../components/bottom-tabs';
import { AppHeader } from '../../components/app-header';
import { TxTrackerWatcher } from '../../components/tx-tracker-watcher';
import { PopupPath } from './paths';
import { schedulePreloadAllScreens } from './route-modules';
import { useStore } from '../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../state/keyring';

/**
 * Routes where bottom-tabs should NOT be shown - full-screen flows with
 * their own back-header (Send / Receive / Swap / the multisig DKG steps /
 * identity / contacts), plus auth and approval screens. Settings sub-pages
 * are hidden too (they carry a back-header), but the settings INDEX
 * ('/settings' exactly) keeps the tab bar - see showTabs below.
 */
const hiddenTabRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SIGN_APPROVAL,
  PopupPath.CAPABILITY_APPROVAL,
  PopupPath.ZCASH_SEND_APPROVAL,
  PopupPath.KEPLR_APPROVAL,
  PopupPath.FROST_APPROVE,
  PopupPath.PASSKEY_APPROVE,
  PopupPath.COSMOS_SIGN,
  PopupPath.CONTACTS,
  PopupPath.IDENTITY,
  PopupPath.SEND,
  PopupPath.RECEIVE,
  PopupPath.SWAP,
  PopupPath.MULTISIG_CREATE,
  PopupPath.MULTISIG_JOIN,
  PopupPath.MULTISIG_SIGN,
  PopupPath.NOTE_SYNC,
  PopupPath.POOL_NOTES,
  PopupPath.ACTIVITY,
];

/**
 * Routes where the persistent AppHeader should NOT be shown. A screen with
 * its own back-header would otherwise render two stacked bars, and the
 * AppHeader's network / wallet controls are meaningless mid-flow.
 *
 * Deliberately excluded: stake, vote, multisig (sessions) and tools - primary
 * destinations with no own back-header, so they rely on the AppHeader +
 * bottom tabs to stay navigable.
 */
const hiddenHeaderRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SIGN_APPROVAL,
  PopupPath.CAPABILITY_APPROVAL,
  PopupPath.ZCASH_SEND_APPROVAL,
  PopupPath.KEPLR_APPROVAL,
  PopupPath.FROST_APPROVE,
  PopupPath.PASSKEY_APPROVE,
  PopupPath.COSMOS_SIGN,
  PopupPath.SETTINGS,
  PopupPath.IDENTITY,
  PopupPath.CONTACTS,
  PopupPath.SEND,
  PopupPath.RECEIVE,
  PopupPath.SWAP,
  PopupPath.MULTISIG_CREATE,
  PopupPath.MULTISIG_JOIN,
  PopupPath.MULTISIG_SIGN,
  PopupPath.NOTE_SYNC,
  PopupPath.POOL_NOTES,
  PopupPath.ACTIVITY,
];

/** check if current path matches any hidden routes */
const matchesRoute = (pathname: string, routes: string[]) =>
  routes.some(route => pathname === route || pathname.startsWith(route + '/'));

export const PopupLayout = () => {
  usePopupReady();
  useSidePanelDelivery();
  useZcashAutoSync();
  const location = useLocation();
  const activeNetwork = useStore(selectActiveNetwork);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const onLoginPage = location.pathname === '/login';
  usePenumbraSwapClaim(activeNetwork, onLoginPage, penumbraAccount);

  // first screen is up - warm every other screen's chunk while idle
  useEffect(schedulePreloadAllScreens, []);

  const showChrome = !matchesRoute(location.pathname, hiddenHeaderRoutes);
  // settings sub-pages carry their own back-header and hide the tab bar
  // (matchesRoute above), but the settings INDEX keeps it - it's one of the
  // four fixed tabs, not a sub-flow.
  const showTabs =
    !matchesRoute(location.pathname, hiddenTabRoutes) &&
    !location.pathname.startsWith(PopupPath.SETTINGS + '/');

  return (
    <div
      data-network={activeNetwork}
      className='relative flex h-full flex-col bg-canvas contain-layout overflow-hidden'
    >
      {showChrome && <AppHeader />}
      <div
        className='min-h-0 flex-1 overflow-y-auto transform-gpu'
        style={{
          paddingBottom: showTabs ? BOTTOM_TABS_HEIGHT : 0,
          // the part that animates on navigation (styles/view-transitions.css)
          viewTransitionName: 'popup-screen',
        }}
      >
        <Outlet />
      </div>
      {showTabs && <BottomTabs />}
      {/* one toast per finished transaction, whichever page started it (the
          page may be gone after a side-panel approval reload) */}
      <TxTrackerWatcher />
    </div>
  );
};
