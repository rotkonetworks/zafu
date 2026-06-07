import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { usePopupReady } from '../../hooks/popup-ready';
import { useZcashAutoSync } from '../../hooks/zcash-auto-sync';
import { usePenumbraSwapClaim } from '../../hooks/penumbra-swap-claim';
import { BottomTabs, BOTTOM_TABS_HEIGHT } from '../../components/bottom-tabs';
import { AppHeader } from '../../components/app-header';
import { MenuDrawer } from '../../components/menu-drawer';
import { PopupPath } from './paths';
import { useStore } from '../../state';
import { selectActiveNetwork, selectPenumbraAccount, type NetworkType } from '../../state/keyring';
import { hasFeature } from '../../config/networks';

type FeatureKey = 'stake' | 'swap' | 'vote' | 'inbox';

/**
 * Bottom-tabs are deliberately minimal — the four destinations users
 * touch every session. Stake / Swap / Vote / Multisig were demoted
 * to the menu drawer (one tap further away). The four kept here:
 *
 *   Home    — balance, recent activity
 *   Receive — quick share of address (primary new-user task)
 *   Send    — primary outgoing action
 *   Inbox   — encrypted memos
 *
 * Inbox is feature-gated by network (transparent-only networks don't
 * have memos and the tab disappears for them).
 *
 * Keplr's wallet uses a similar 3-4 tab pattern: balance + send +
 * receive + history. We follow the convention; the user noted "more
 * icons" → bottom-tabs already are icon + small label stacked, which
 * is the most compact discoverable pattern.
 */
const BOTTOM_TABS: ReadonlyArray<{ path: PopupPath; icon: JSX.Element; label: string; feature?: FeatureKey }> = [
  { path: PopupPath.INDEX,   icon: <span className='i-lucide-home h-5 w-5' />,            label: 'home' },
  { path: PopupPath.RECEIVE, icon: <span className='i-lucide-arrow-down h-5 w-5' />,      label: 'receive' },
  { path: PopupPath.SEND,    icon: <span className='i-lucide-arrow-up h-5 w-5' />,        label: 'send' },
  { path: PopupPath.INBOX,   icon: <span className='i-lucide-mail h-5 w-5' />,            label: 'inbox', feature: 'inbox' },
];

const getTabsForNetwork = (network: NetworkType) =>
  BOTTOM_TABS.filter(tab => !tab.feature || hasFeature(network, tab.feature));

/**
 * Routes where bottom-tabs should NOT be shown. SEND and RECEIVE used
 * to live here (back when they weren't top-level tabs) — they're now
 * primary destinations so the bar stays visible on them. The
 * remaining hidden routes are auth / approval / multi-step flows
 * where the user is in the middle of a one-shot interaction.
 */
const hiddenTabRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SIGN_APPROVAL,
  PopupPath.CAPABILITY_APPROVAL,
  PopupPath.COSMOS_SIGN,
  PopupPath.CONTACTS,
  PopupPath.MULTISIG_CREATE,
  PopupPath.MULTISIG_JOIN,
  PopupPath.MULTISIG_SIGN,
];

/** routes where header should NOT be shown (auth/approval flows only) */
const hiddenHeaderRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SIGN_APPROVAL,
  PopupPath.CAPABILITY_APPROVAL,
  PopupPath.COSMOS_SIGN,
];

/** check if current path matches any hidden routes */
const matchesRoute = (pathname: string, routes: string[]) =>
  routes.some(route => pathname === route || pathname.startsWith(route + '/'));

export const PopupLayout = () => {
  usePopupReady();
  useZcashAutoSync();
  const location = useLocation();
  const activeNetwork = useStore(selectActiveNetwork);
  const penumbraAccount = useStore(selectPenumbraAccount);
  const onLoginPage = location.pathname === '/login';
  usePenumbraSwapClaim(activeNetwork, onLoginPage, penumbraAccount);
  const [menuOpen, setMenuOpen] = useState(false);

  const tabs = getTabsForNetwork(activeNetwork);
  const showChrome = !matchesRoute(location.pathname, hiddenHeaderRoutes);
  const showTabs = showChrome && !matchesRoute(location.pathname, hiddenTabRoutes);

  return (
    <div data-network={activeNetwork} className='relative flex h-full flex-col bg-canvas contain-layout overflow-hidden'>
      {showChrome && <AppHeader onMenuClick={() => setMenuOpen(true)} />}
      <div
        className='min-h-0 flex-1 overflow-y-auto transform-gpu'
        style={{ paddingBottom: showTabs ? BOTTOM_TABS_HEIGHT : 0 }}
      >
        <Outlet />
      </div>
      {showTabs && <BottomTabs tabs={tabs} />}
      {showChrome && <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />}
    </div>
  );
};
