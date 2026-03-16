/**
 * persistent app header — minimal, no dropdowns
 * tap network dot → cycle network
 * tap wallet name → cycle wallet identity
 */

import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { PopupPath } from '../routes/popup/paths';
import {
  selectActiveNetwork,
  selectEnabledNetworks,
  selectEffectiveKeyInfo,
  selectSetActiveNetwork,
  selectKeyInfosForActiveNetwork,
  selectSelectKeyRing,
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
  const keyInfos = useStore(selectKeyInfosForActiveNetwork);
  const selectKeyRing = useStore(selectSelectKeyRing);

  const networkInfo = getNetwork(activeNetwork);
  // mnemonic vaults derive zcash keys directly — no zcash wallet record
  const walletName = activeNetwork === 'zcash' && selectedKeyInfo?.type !== 'mnemonic'
    ? activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'no wallet'
    : selectedKeyInfo?.name ?? 'no wallet';

  /** tap cycles through enabled networks */
  const cycleNetwork = () => {
    if (enabledNetworks.length <= 1) {
      navigate(PopupPath.SETTINGS_NETWORKS);
      return;
    }
    const idx = enabledNetworks.indexOf(activeNetwork);
    const next = enabledNetworks[(idx + 1) % enabledNetworks.length]!;
    void setActiveNetwork(next);
  };

  /** tap cycles through wallet identities */
  const cycleWallet = () => {
    if (keyInfos.length <= 1) {
      navigate(PopupPath.SETTINGS_WALLETS);
      return;
    }
    const currentId = selectedKeyInfo?.id;
    const idx = keyInfos.findIndex(k => k.id === currentId);
    const next = keyInfos[(idx + 1) % keyInfos.length]!;
    void selectKeyRing(next.id);
  };

  return (
    <header className='sticky top-0 z-50 flex shrink-0 items-center justify-between px-3 py-2 border-b border-border/40 bg-background/80 backdrop-blur-sm'>
      {/* network indicator — tap to cycle */}
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

      {/* wallet name — tap to cycle identity, shows dot per vault */}
      <button
        onClick={cycleWallet}
        className='flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors'
        title={`${walletName} — tap to switch wallet`}
      >
        {keyInfos.length > 1 && (
          <div className='flex items-center gap-0.5'>
            {keyInfos.map(k => (
              <div
                key={k.id}
                className={cn(
                  'rounded-full bg-foreground transition-all',
                  k.id === selectedKeyInfo?.id ? 'h-1.5 w-1.5' : 'h-1 w-1 opacity-30',
                )}
              />
            ))}
          </div>
        )}
        <span className='text-sm font-medium truncate max-w-[120px]'>{walletName}</span>
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
