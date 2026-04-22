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
import { isPro } from '../../state/license';
import { hasFeature } from '../../config/networks';

type FeatureKey = 'stake' | 'swap' | 'vote' | 'inbox';

/** all possible tabs — each gated by a network feature */
const ALL_TABS: ReadonlyArray<{ path: PopupPath; icon: JSX.Element; label: string; feature?: FeatureKey }> = [
  { path: PopupPath.INDEX,  icon: <span className='i-lucide-home h-5 w-5' />,              label: 'Home' },
  { path: PopupPath.INBOX,  icon: <span className='i-lucide-mail h-5 w-5' />,              label: 'Inbox',  feature: 'inbox' },
  { path: PopupPath.STAKE,  icon: <span className='i-lucide-layers h-5 w-5' />,            label: 'Stake',  feature: 'stake' },
  { path: PopupPath.SWAP,   icon: <span className='i-lucide-arrow-left-right h-5 w-5' />,  label: 'Swap',   feature: 'swap' },
  { path: PopupPath.VOTE,   icon: <span className='i-lucide-vote h-5 w-5' />,              label: 'Vote',   feature: 'vote' },
];

/** multisig tab — injected only when user has FROST wallets */
const MULTISIG_TAB = {
  path: PopupPath.MULTISIG,
  icon: <span className='i-lucide-shield h-5 w-5' />,
  label: 'Multisig',
} as const;

/** derive tabs from network features — pure filter, no mutation */
const getTabsForNetwork = (network: NetworkType) =>
  ALL_TABS.filter(tab => !tab.feature || hasFeature(network, tab.feature));

/** routes where bottom tabs should NOT be shown */
const hiddenTabRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SIGN_APPROVAL,
  PopupPath.CAPABILITY_APPROVAL,
  PopupPath.COSMOS_SIGN,
  PopupPath.SEND,
  PopupPath.RECEIVE,
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
  const pro = useStore(isPro);
  const onLoginPage = location.pathname === '/login';
  usePenumbraSwapClaim(activeNetwork, onLoginPage, penumbraAccount);
  const [menuOpen, setMenuOpen] = useState(false);

  const networkTabs = getTabsForNetwork(activeNetwork);
  const tabs = activeNetwork === 'zcash' && pro ? [...networkTabs, MULTISIG_TAB] : networkTabs;
  const showChrome = !matchesRoute(location.pathname, hiddenHeaderRoutes);
  const showTabs = showChrome && !matchesRoute(location.pathname, hiddenTabRoutes);

  return (
    <div data-network={activeNetwork} className='relative flex h-full flex-col bg-background contain-layout overflow-hidden'>
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
