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
import { BARE_ROUTES, matchesRoute } from './paths';
import { schedulePreloadAllScreens } from './route-modules';
import { intentHandlers, navTimingOn, Painted } from './preload';
import { useStore } from '../../state';
import { selectActiveNetwork, selectPenumbraAccount } from '../../state/keyring';

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

  const showChrome = !matchesRoute(location.pathname, BARE_ROUTES);

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
