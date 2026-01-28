import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { usePopupReady } from '../../hooks/popup-ready';
import { BottomTabs, BOTTOM_TABS_HEIGHT } from '../../components/bottom-tabs';
import { AppHeader } from '../../components/app-header';
import { MenuDrawer } from '../../components/menu-drawer';
import { PopupPath } from './paths';
import {
  HomeIcon,
  StackIcon,
  MixIcon,
  ClockIcon,
  EnvelopeClosedIcon,
} from '@radix-ui/react-icons';
import { useStore } from '../../state';
import { selectActiveNetwork, type NetworkType } from '../../state/keyring';
import { hasFeature } from '../../config/networks';

/** derive tabs from network features - solidjs-style computed */
const getTabsForNetwork = (network: NetworkType) => {
  const tabs = [
    { path: PopupPath.INDEX, icon: <HomeIcon className='h-5 w-5' />, label: 'Home' },
  ];
  if (hasFeature(network, 'inbox')) {
    tabs.push({ path: PopupPath.INBOX, icon: <EnvelopeClosedIcon className='h-5 w-5' />, label: 'Inbox' });
  }
  if (hasFeature(network, 'stake')) {
    tabs.push({ path: PopupPath.STAKE, icon: <StackIcon className='h-5 w-5' />, label: 'Stake' });
  }
  if (hasFeature(network, 'swap')) {
    tabs.push({ path: PopupPath.SWAP, icon: <MixIcon className='h-5 w-5' />, label: 'Swap' });
  }
  if (hasFeature(network, 'history')) {
    tabs.push({ path: PopupPath.HISTORY, icon: <ClockIcon className='h-5 w-5' />, label: 'History' });
  }
  return tabs;
};

/** routes where bottom tabs should NOT be shown */
const hiddenTabRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SEND,
  PopupPath.RECEIVE,
  PopupPath.CONTACTS,
];

/** routes where header should NOT be shown (have their own headers) */
const hiddenHeaderRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SETTINGS,
  PopupPath.CONTACTS,
  PopupPath.SEND,
  PopupPath.RECEIVE,
];

/** check if current path matches any hidden routes */
const matchesRoute = (pathname: string, routes: string[]) =>
  routes.some(route => pathname === route || pathname.startsWith(route + '/'));

export const PopupLayout = () => {
  usePopupReady();
  const location = useLocation();
  const activeNetwork = useStore(selectActiveNetwork);
  const [menuOpen, setMenuOpen] = useState(false);

  const tabs = getTabsForNetwork(activeNetwork);
  const showChrome = !matchesRoute(location.pathname, hiddenHeaderRoutes);
  const showTabs = showChrome && !matchesRoute(location.pathname, hiddenTabRoutes);

  return (
    <div className='relative flex grow flex-col bg-card-radial contain-layout'>
      {showChrome && <AppHeader onMenuClick={() => setMenuOpen(true)} />}
      <div
        className='flex-1 overflow-y-auto transform-gpu'
        style={{ paddingBottom: showTabs ? BOTTOM_TABS_HEIGHT : 0 }}
      >
        {/* content area with CSS containment for isolated repaints */}
        <div className='contain-content'>
          <Outlet />
        </div>
      </div>
      {showTabs && <BottomTabs tabs={tabs} />}
      {showChrome && <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />}
    </div>
  );
};
