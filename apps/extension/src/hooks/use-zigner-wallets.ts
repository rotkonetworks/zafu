/**
 * hook for accessing zigner wallets state in ui components
 */

import { useMemo } from 'react';
import { useStore } from '../state';
import {
  zignerWalletsSelector,
  activeZignerWalletSelector,
} from '../state/zigner-wallets';
import type { ZignerWalletInfo } from '@repo/ui/components/ui/zigner-wallet-switcher';
import { getEnabledNetworks } from '@repo/wallet/networks';

/**
 * hook to access zigner wallets for the wallet switcher ui
 */
export function useZignerWalletsList() {
  const { wallets, activeWalletIndex, setActiveWallet, addWallet } = useStore(
    zignerWalletsSelector,
  );

  const walletInfoList: ZignerWalletInfo[] = useMemo(
    () =>
      wallets.map((wallet) => ({
        id: wallet.id,
        label: wallet.label,
        zignerAccountIndex: wallet.zignerAccountIndex,
        enabledNetworks: getEnabledNetworks(wallet),
      })),
    [wallets],
  );

  return {
    wallets: walletInfoList,
    activeIndex: activeWalletIndex,
    setActiveWallet,
    addWallet,
    hasWallets: wallets.length > 0,
  };
}

/**
 * hook to access the currently active zigner wallet
 */
export function useActiveZignerWallet() {
  const wallet = useStore(activeZignerWalletSelector);

  return {
    wallet,
    hasWallet: !!wallet,
    enabledNetworks: wallet ? getEnabledNetworks(wallet) : [],
  };
}

/**
 * hook to access active network state
 */
export function useActiveNetwork() {
  const { activeNetwork, setActiveNetwork } = useStore(
    (state) => state.activeNetwork,
  );

  return {
    activeNetwork,
    setActiveNetwork,
  };
}
