import { PenumbraStartSheet } from '../../components/wallet/penumbra-start-sheet';
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
import { schedulePreloadTabRoots } from './route-modules';
import { intentHandlers, navTimingOn, Painted } from './preload';
import { useStore } from '../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../state/keyring';

/**
 * Screens that live outside the app shell: welcome, unlock and the approval windows a
 * site or a device opens. Every other screen keeps the header and the tabs,
 * so moving around never changes the frame.
 */
const bareRoutes = [
  PopupPath.LOGIN,
  PopupPath.FORGOT_PASSWORD,
  PopupPath.WELCOME,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SIGN_APPROVAL,
  PopupPath.CAPABILITY_APPROVAL,
  PopupPath.ZCASH_SEND_APPROVAL,
  PopupPath.KEPLR_APPROVAL,
  PopupPath.CONTACT_DISCOVERY_APPROVAL,
  PopupPath.DESTINATION_APPROVAL,
  PopupPath.CONTACT_PICKER,
  PopupPath.FROST_APPROVE,
  PopupPath.PASSKEY_APPROVE,
  PopupPath.COSMOS_SIGN,
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

  // first screen is up - warm the four tab roots while idle; intent
  // preloading (hover/press on a nav primitive) covers everything else
  useEffect(schedulePreloadTabRoots, []);

  const showChrome = !matchesRoute(location.pathname, bareRoutes);

  return (
    <div
      data-network={activeNetwork}
      className='relative flex h-full flex-col bg-canvas contain-layout overflow-hidden'
      // intent preloading: every nav primitive inside (sheets too, through
      // React's portal bubbling) announces its target as data-preload
      {...intentHandlers}
    >
      {navTimingOn && <Painted target={location.pathname} />}
      {showChrome && <AppHeader />}
      <div
        className='min-h-0 flex-1 overflow-y-auto transform-gpu'
        style={{
          paddingBottom: showChrome ? BOTTOM_TABS_HEIGHT : 0,
          // the part that animates on navigation (styles/view-transitions.css)
          viewTransitionName: 'popup-screen',
        }}
      >
        {/* side-panel width rule: content never grows past the popup's own 400px,
            however wide the panel is. the background, header and tabs still
            stretch full width; only this column is capped. */}
        <div className='mx-auto h-full max-w-[400px]'>
          <Outlet />
        </div>
      </div>
      {showChrome && <BottomTabs />}
      {/* one toast per finished transaction, whichever page started it (the
          page may be gone after a side-panel approval reload) */}
      <TxTrackerWatcher />
      <PenumbraStartSheet />
    </div>
  );
};
