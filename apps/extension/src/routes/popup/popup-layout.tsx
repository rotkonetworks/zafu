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
import {
  selectActiveNetwork,
  selectEffectiveKeyInfo,
  selectPenumbraAccount,
  type NetworkType,
} from '../../state/keyring';
import { hasFeature } from '../../config/networks';

type FeatureKey = 'stake' | 'swap' | 'vote' | 'inbox' | 'multisig';

/**
 * Bottom-tabs are the places users navigate to, not one-shot actions.
 * Send / Receive are launched from buttons on the home hero (an action,
 * not a destination), so they aren't tabs. The bar is:
 *
 *   Home     — balance, recent activity
 *   Inbox    — encrypted memos
 *   Multisig — FROST threshold wallets + pending signing sessions
 *   Vote     — governance
 *
 * Inbox / Multisig / Vote are feature-gated by network (they only appear
 * on chains that support them — see config/networks.ts), so a transparent
 * chain collapses the bar down to Home plus whatever it supports.
 */
const BOTTOM_TABS: readonly {
  path: PopupPath;
  icon: JSX.Element;
  label: string;
  feature?: FeatureKey;
}[] = [
  { path: PopupPath.INDEX, icon: <span className='i-lucide-home h-5 w-5' />, label: 'home' },
  {
    path: PopupPath.INBOX,
    icon: <span className='i-lucide-mail h-5 w-5' />,
    label: 'inbox',
    feature: 'inbox',
  },
  {
    path: PopupPath.MULTISIG,
    icon: <span className='i-lucide-users h-5 w-5' />,
    label: 'multisig',
    feature: 'multisig',
  },
  {
    path: PopupPath.VOTE,
    icon: <span className='i-lucide-vote h-5 w-5' />,
    label: 'vote',
    feature: 'vote',
  },
];

const MULTISIG_TAB = {
  path: PopupPath.MULTISIG,
  icon: <span className='i-lucide-key h-5 w-5' />,
  label: 'multisig',
} as const;

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
  PopupPath.ZCASH_SEND_APPROVAL,
  PopupPath.FROST_APPROVE,
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
  PopupPath.ZCASH_SEND_APPROVAL,
  PopupPath.FROST_APPROVE,
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
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const onLoginPage = location.pathname === '/login';
  usePenumbraSwapClaim(activeNetwork, onLoginPage, penumbraAccount);
  const [menuOpen, setMenuOpen] = useState(false);

  const networkTabs = getTabsForNetwork(activeNetwork);
  const tabs =
    selectedKeyInfo?.type === 'frost-multisig' ? [...networkTabs, MULTISIG_TAB] : networkTabs;
  const showChrome = !matchesRoute(location.pathname, hiddenHeaderRoutes);
  const showTabs = showChrome && !matchesRoute(location.pathname, hiddenTabRoutes);

  return (
    <div
      data-network={activeNetwork}
      className='relative flex h-full flex-col bg-canvas contain-layout overflow-hidden'
    >
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
