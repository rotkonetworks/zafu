/**
 * persistent app header - minimal
 * click the network chip -> pick a network from a dropdown
 * click the wallet chip  -> pick an active wallet from a dropdown
 * no silent cycling, no stray-tap wallet/network switches
 */

import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state';
import {
  selectActiveNetwork,
  selectEnabledNetworks,
  selectEffectiveKeyInfo,
  selectSetActiveNetwork,
  selectKeyInfosForActiveNetwork,
  selectSelectKeyRing,
} from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { selectHideBalances } from '../state/privacy';
import { getNetwork } from '../config/networks';
import { cn } from '@repo/ui/lib/utils';

interface AppHeaderProps {
  onMenuClick: () => void;
}

type OpenPicker = 'network' | 'wallet' | null;

export const AppHeader = ({ onMenuClick }: AppHeaderProps) => {
  const activeNetwork = useStore(selectActiveNetwork);
  const enabledNetworks = useStore(selectEnabledNetworks);
  const setActiveNetwork = useStore(selectSetActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  // perf: selectKeyInfosForActiveNetwork .filter()s a new array every read.
  // Without shallow equality the AppHeader re-renders on every state tick.
  const keyInfos = useStore(useShallow(selectKeyInfosForActiveNetwork));
  const selectKeyRing = useStore(selectSelectKeyRing);
  const hideBalances = useStore(selectHideBalances);
  const setPrivacySetting = useStore(s => s.privacy.setSetting);

  const [openPicker, setOpenPicker] = useState<OpenPicker>(null);

  const networkInfo = getNetwork(activeNetwork);
  // mnemonic vaults derive zcash keys directly - no zcash wallet record
  const walletName =
    activeNetwork === 'zcash' && selectedKeyInfo?.type !== 'mnemonic'
      ? (activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'no wallet')
      : (selectedKeyInfo?.name ?? 'no wallet');

  const toggle = (picker: OpenPicker) => setOpenPicker(prev => (prev === picker ? null : picker));

  const pickNetwork = (n: (typeof enabledNetworks)[number]) => {
    setOpenPicker(null);
    if (n !== activeNetwork) {
      void setActiveNetwork(n);
    }
  };

  const pickWallet = (id: string) => {
    setOpenPicker(null);
    if (id !== selectedKeyInfo?.id) {
      void selectKeyRing(id);
    }
  };

  return (
    <header className='sticky top-0 z-50 flex shrink-0 items-center justify-between gap-2 border-b border-border-soft bg-canvas/80 px-3 py-2 backdrop-blur-sm'>
      {/* click-away backdrop for any open picker */}
      {openPicker && <div className='fixed inset-0 z-40' onClick={() => setOpenPicker(null)} />}

      {/* network picker */}
      <div className='relative z-50'>
        <button
          onClick={() => toggle('network')}
          className='flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-elev-1'
          title='switch network'
          aria-haspopup='menu'
          aria-expanded={openPicker === 'network'}
        >
          <span className={cn('h-2.5 w-2.5 rounded-full', networkInfo.color)} />
          <span className='text-data text-fg-high'>{networkInfo.name}</span>
          <span className='i-lucide-chevron-down h-3 w-3 text-fg-muted' />
        </button>
        {openPicker === 'network' && (
          <div className='absolute left-0 top-full z-50 mt-1 min-w-40 rounded-md border border-border-soft bg-canvas py-1 shadow-xl'>
            {enabledNetworks.map(n => (
              <button
                key={n}
                onClick={() => pickNetwork(n)}
                className='flex w-full items-center gap-2 px-3 py-2 text-left text-data text-fg transition-colors hover:bg-elev-1 hover:text-fg-high'
              >
                <span className={cn('h-2 w-2 rounded-full', getNetwork(n).color)} />
                <span className='flex-1 truncate'>{getNetwork(n).name}</span>
                {n === activeNetwork && (
                  <span className='i-lucide-check h-3.5 w-3.5 text-zigner-gold' />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* wallet picker */}
      <div className='relative z-50'>
        <button
          onClick={() => toggle('wallet')}
          className='flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-elev-1'
          title='switch wallet'
          aria-haspopup='menu'
          aria-expanded={openPicker === 'wallet'}
        >
          <span className='max-w-32 truncate text-data text-fg-high'>{walletName}</span>
          <span className='i-lucide-chevron-down h-3 w-3 text-fg-muted' />
        </button>
        {openPicker === 'wallet' && (
          <div className='absolute right-0 top-full z-50 mt-1 min-w-40 max-w-56 rounded-md border border-border-soft bg-canvas py-1 shadow-xl'>
            {keyInfos.length === 0 ? (
              <span className='block px-3 py-2 text-data text-fg-muted'>no wallets</span>
            ) : (
              keyInfos.map(k => (
                <button
                  key={k.id}
                  onClick={() => pickWallet(k.id)}
                  className='flex w-full items-center gap-2 px-3 py-2 text-left text-data text-fg transition-colors hover:bg-elev-1 hover:text-fg-high'
                >
                  <span className='flex-1 truncate'>{k.name}</span>
                  {k.id === selectedKeyInfo?.id && (
                    <span className='i-lucide-check h-3.5 w-3.5 text-zigner-gold' />
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* hide balances - shoulder-surfing / screen-share privacy */}
      <button
        onClick={() => void setPrivacySetting('hideBalances', !hideBalances)}
        className='ml-auto rounded-md p-2 text-fg-muted transition-colors hover:bg-elev-1 hover:text-fg-high'
        title={hideBalances ? 'show balances' : 'hide balances'}
        aria-label={hideBalances ? 'show balances' : 'hide balances'}
      >
        <span className={cn(hideBalances ? 'i-lucide-eye-off' : 'i-lucide-eye', 'h-4 w-4')} />
      </button>

      {/* menu */}
      <button
        onClick={onMenuClick}
        className='rounded-md p-2 text-fg-muted transition-colors hover:bg-elev-1 hover:text-fg-high'
        aria-label='open menu'
      >
        <span className='i-lucide-menu h-4 w-4' />
      </button>
    </header>
  );
};

export const APP_HEADER_HEIGHT = 44;
