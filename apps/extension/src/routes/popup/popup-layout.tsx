import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { usePopupReady } from '../../hooks/popup-ready';
import { useZcashAutoSync } from '../../hooks/zcash-auto-sync';
import { usePenumbraSwapClaim } from '../../hooks/penumbra-swap-claim';
import { BottomTabs, BOTTOM_TABS_HEIGHT } from '../../components/bottom-tabs';
import { AppHeader } from '../../components/app-header';
import { MenuDrawer } from '../../components/menu-drawer';
import { PenumbraSendWatcher } from '../../components/penumbra-send-watcher';
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
  { path: PopupPath.INDEX, icon: <span className='i-zafu-mon h-5 w-5' />, label: 'home' },
  {
    path: PopupPath.INBOX,
    icon: <span className='i-zafu-letter h-5 w-5' />,
    label: 'inbox',
    feature: 'inbox',
  },
  {
    path: PopupPath.STAKE,
    icon: <span className='i-ph-coins h-5 w-5' />,
    label: 'stake',
    feature: 'stake',
  },
  {
    path: PopupPath.MULTISIG,
    icon: <span className='i-zafu-torii h-5 w-5' />,
    label: 'multisig',
    feature: 'multisig',
  },
  {
    path: PopupPath.VOTE,
    icon: <span className='i-zafu-sensu h-5 w-5' />,
    label: 'vote',
    feature: 'vote',
  },
];

const MULTISIG_TAB = {
  path: PopupPath.MULTISIG,
  icon: <span className='i-zafu-hanko h-5 w-5' />,
  label: 'multisig',
} as const;

const getTabsForNetwork = (network: NetworkType) =>
  BOTTOM_TABS.filter(tab => !tab.feature || hasFeature(network, tab.feature));

/**
 * Routes where bottom-tabs should NOT be shown. The bar belongs on the
 * primary destinations (home / inbox / multisig / vote); it has no place
 * under a focused sub-flow. Send / Receive / Settings and their subtrees
 * are flows with their own screen chrome, so the tab rail is hidden there
 * (it would otherwise sit beneath a Send / Receive / settings screen). The
 * rest are auth / approval / multi-step flows - one-shot interactions.
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
  PopupPath.IDENTITY,
  PopupPath.SEND,
  PopupPath.RECEIVE,
  PopupPath.SWAP,
  PopupPath.SETTINGS,
  PopupPath.MULTISIG_CREATE,
  PopupPath.MULTISIG_JOIN,
  PopupPath.MULTISIG_SIGN,
];

/**
 * Routes where the persistent AppHeader should NOT be shown. A screen with
 * its own back-header would otherwise render two stacked bars, and the
 * AppHeader's network / wallet controls are meaningless mid-flow. Covers
 * auth / approval flows plus every secondary screen that carries its own
 * header: settings (whole subtree), identity, contacts, send, receive,
 * swap, and the multisig sub-flows.
 *
 * Deliberately excluded: the multisig tab (/multisig) and stake are
 * primary destinations with no own back-header - they rely on the
 * AppHeader + bottom tabs to stay navigable, so their header stays.
 */
const hiddenHeaderRoutes = [
  PopupPath.LOGIN,
  PopupPath.TRANSACTION_APPROVAL,
  PopupPath.ORIGIN_APPROVAL,
  PopupPath.SIGN_APPROVAL,
  PopupPath.CAPABILITY_APPROVAL,
  PopupPath.ZCASH_SEND_APPROVAL,
  PopupPath.FROST_APPROVE,
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
  // On a frost wallet, guarantee a multisig tab - but only append one if the
  // network's own feature-gated tabs don't already include it, otherwise the
  // rail shows two tabs both labeled "multisig". Also respect network support:
  // a frost wallet viewing a network without multisig (e.g. Penumbra) must not
  // force a tab for a feature that network cannot use.
  const hasMultisigTab = networkTabs.some(tab => tab.path === PopupPath.MULTISIG);
  const tabs =
    selectedKeyInfo?.type === 'frost-multisig' &&
    !hasMultisigTab &&
    hasFeature(activeNetwork, 'multisig')
      ? [...networkTabs, MULTISIG_TAB]
      : networkTabs;
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
      {/* surfaces the outcome of a service-worker-driven send even when the
          originating page was destroyed (side-panel approval reload) */}
      <PenumbraSendWatcher />
    </div>
  );
};
