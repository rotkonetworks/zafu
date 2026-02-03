/**
 * persistent app header with network/wallet selectors and menu
 * solidjs-style: atomic selectors, composable primitives
 */

import { ChevronDownIcon, HamburgerMenuIcon, PlusIcon } from '@radix-ui/react-icons';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { PopupPath } from '../routes/popup/paths';
import {
  selectActiveNetwork,
  selectEnabledNetworks,
  selectSetActiveNetwork,
  selectSelectedKeyInfo,
} from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { getNetwork } from '../config/networks';
import { Dropdown } from './primitives/dropdown';
import { cn } from '@repo/ui/lib/utils';

interface AppHeaderProps {
  onMenuClick: () => void;
}

export const AppHeader = ({ onMenuClick }: AppHeaderProps) => {
  const navigate = useNavigate();
  // atomic selectors - each only re-renders when its specific value changes
  const activeNetwork = useStore(selectActiveNetwork);
  const enabledNetworks = useStore(selectEnabledNetworks);
  const setActiveNetwork = useStore(selectSetActiveNetwork);
  const selectedKeyInfo = useStore(selectSelectedKeyInfo);
  const activeZcashWallet = useStore(selectActiveZcashWallet);

  const networkInfo = getNetwork(activeNetwork);
  // for zcash: use stored wallet label, or fall back to mnemonic wallet name
  const walletName = activeNetwork === 'zcash'
    ? activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'No wallet'
    : selectedKeyInfo?.name ?? 'No wallet';

  return (
    <header className='relative z-50 flex items-center justify-between px-3 py-2 border-b border-border/40 bg-background/80 backdrop-blur-sm'>
      {/* network selector */}
      <Dropdown
        trigger={({ toggle }) => (
          <button
            onClick={toggle}
            className='flex items-center gap-1.5 px-2 py-1 rounded hover:bg-muted/50 transition-colors'
          >
            <div className={cn('h-2 w-2 rounded-full', networkInfo.color)} />
            <span className='text-sm font-medium'>{networkInfo.name}</span>
            <ChevronDownIcon className='h-3 w-3 text-muted-foreground' />
          </button>
        )}
      >
        {({ close }) => (
          <div className='absolute left-0 top-full mt-1 z-50 min-w-[140px] rounded border border-border bg-popover p-1 shadow-lg'>
            {enabledNetworks.map(network => {
              const info = getNetwork(network);
              return (
                <button
                  key={network}
                  onClick={() => {
                    void setActiveNetwork(network);
                    close();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted/50',
                    network === activeNetwork && 'bg-muted/50'
                  )}
                >
                  <div className={cn('h-2 w-2 rounded-full', info.color)} />
                  <span>{info.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </Dropdown>

      {/* wallet selector */}
      <Dropdown
        className='relative flex-1 mx-2'
        trigger={({ toggle }) => (
          <button
            onClick={toggle}
            className='flex items-center justify-center gap-1 w-full px-2 py-1 rounded hover:bg-muted/50 transition-colors'
          >
            <span className='text-sm font-medium truncate max-w-[120px]'>{walletName}</span>
            <ChevronDownIcon className='h-3 w-3 text-muted-foreground flex-shrink-0' />
          </button>
        )}
      >
        {({ close }) => (
          <div className='absolute left-1/2 -translate-x-1/2 top-full mt-1 z-50 min-w-[180px] rounded border border-border bg-popover p-1 shadow-lg'>
            <button
              onClick={() => {
                navigate(PopupPath.SETTINGS_ZIGNER);
                close();
              }}
              className='flex w-full items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted/50'
            >
              <PlusIcon className='h-3 w-3' />
              <span>add wallet via zigner</span>
            </button>
            <div className='border-t border-border/40 my-1' />
            <div className='px-2 py-1 text-xs text-muted-foreground'>
              account selection coming soon
            </div>
          </div>
        )}
      </Dropdown>

      {/* menu button */}
      <button
        onClick={onMenuClick}
        className='p-2 rounded hover:bg-muted/50 transition-colors'
      >
        <HamburgerMenuIcon className='h-4 w-4' />
      </button>
    </header>
  );
};

export const APP_HEADER_HEIGHT = 44;
