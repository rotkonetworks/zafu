/**
 * persistent app header — minimal, no dropdowns
 * tap wallet name → wallet settings, tap network dot → network settings
 */

import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { PopupPath } from '../routes/popup/paths';
import {
  selectActiveNetwork,
  selectEnabledNetworks,
  selectEffectiveKeyInfo,
  selectSetActiveNetwork,
} from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { getNetwork } from '../config/networks';
import { cn } from '@repo/ui/lib/utils';

interface AppHeaderProps {
  onMenuClick: () => void;
}

export const AppHeader = ({ onMenuClick }: AppHeaderProps) => {
  const navigate = useNavigate();
  const activeNetwork = useStore(selectActiveNetwork);
  const enabledNetworks = useStore(selectEnabledNetworks);
  const setActiveNetwork = useStore(selectSetActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const activeZcashWallet = useStore(selectActiveZcashWallet);

  const networkInfo = getNetwork(activeNetwork);
  const walletName = activeNetwork === 'zcash'
    ? activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'no wallet'
    : selectedKeyInfo?.name ?? 'no wallet';

  /** tap cycles through enabled networks, long-press goes to settings */
  const cycleNetwork = () => {
    if (enabledNetworks.length <= 1) {
      navigate(PopupPath.SETTINGS_NETWORKS);
      return;
    }
    const idx = enabledNetworks.indexOf(activeNetwork);
    const next = enabledNetworks[(idx + 1) % enabledNetworks.length]!;
    void setActiveNetwork(next);
  };

  return (
    <header className='sticky top-0 z-50 flex shrink-0 items-center justify-between px-3 py-2 border-b border-border/40 bg-background/80 backdrop-blur-sm'>
      {/* network indicator — tap to cycle, holds network dots for all enabled */}
      <button
        onClick={cycleNetwork}
        className='flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors'
        title={`${networkInfo.name} — tap to switch network`}
      >
        <div className='flex items-center gap-1'>
          {enabledNetworks.map(n => (
            <div
              key={n}
              className={cn(
                'rounded-full transition-all',
                n === activeNetwork ? 'h-2.5 w-2.5' : 'h-1.5 w-1.5 opacity-40',
                getNetwork(n).color,
              )}
            />
          ))}
        </div>
        <span className='text-sm font-medium'>{networkInfo.name}</span>
      </button>

      {/* wallet name — tap to manage wallets */}
      <button
        onClick={() => navigate(PopupPath.SETTINGS_WALLETS)}
        className='flex-1 mx-2 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors text-center'
      >
        <span className='text-sm font-medium truncate block max-w-[140px] mx-auto'>{walletName}</span>
      </button>

      {/* menu */}
      <button
        onClick={onMenuClick}
        className='p-2 rounded-lg hover:bg-muted/50 transition-colors'
      >
        <span className='i-lucide-menu h-4 w-4' />
      </button>
    </header>
  );
};

export const APP_HEADER_HEIGHT = 44;
