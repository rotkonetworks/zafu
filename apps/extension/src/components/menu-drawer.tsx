/**
 * slide-out menu drawer
 * includes navigation, about info, and donation
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { selectLock, selectActiveNetwork, selectEffectiveKeyInfo } from '../state/keyring';
import { PopupPath } from '../routes/popup/paths';
import { cn } from '@repo/ui/lib/utils';
import { isSidePanel } from '../utils/popup-detection';

/** donation addresses per network */
const DONATE: Record<string, { address: string; name: string }> = {
  zcash: {
    address: 'u153khs43zxz6hcnlwnut77knyqmursnutmungxjxd7khruunhj77ea6tmpzxct9wzlgen66jxwc93ea053j22afkktu7hrs9rmsz003h3',
    name: 'zafu / rotko networks',
  },
};

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const MenuDrawer = ({ open, onClose }: MenuDrawerProps) => {
  const navigate = useNavigate();
  const lock = useStore(selectLock);
  const activeNetwork = useStore(selectActiveNetwork);
  const keyInfo = useStore(selectEffectiveKeyInfo);
  const inSidePanel = isSidePanel();
  const [zidCopied, setZidCopied] = useState(false);

  const zidPubkey = keyInfo?.insensitive?.['zid'] as string | undefined;
  const zidAddress = zidPubkey ? 'zid' + zidPubkey.slice(0, 16) : undefined;

  const handleLock = () => {
    lock();
    onClose();
    navigate(PopupPath.LOGIN);
  };

  const handleOpenPopupWindow = async () => {
    onClose();
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('popup.html'),
        type: 'popup',
        width: 400,
        height: 628,
      });
      window.close();
    } catch (e) {
      console.error('Failed to open popup window:', e);
    }
  };

  const donation = activeNetwork ? DONATE[activeNetwork] : undefined;

  const handleDonate = useCallback(() => {
    if (!donation) return;
    onClose();
    navigate(PopupPath.SEND, { state: { prefillRecipient: donation.address } });
  }, [donation, navigate, onClose]);

  if (!open) return null;

  const menuItems = [
    {
      icon: 'i-lucide-fingerprint',
      label: 'identity',
      onClick: () => { navigate(PopupPath.IDENTITY); onClose(); },
    },
    {
      icon: 'i-lucide-user',
      label: 'contacts',
      onClick: () => { navigate(PopupPath.CONTACTS); onClose(); },
    },
    {
      icon: 'i-lucide-globe',
      label: 'networks',
      onClick: () => { navigate(PopupPath.SETTINGS_NETWORKS); onClose(); },
    },
    {
      icon: 'i-lucide-wallet',
      label: 'wallets',
      onClick: () => { navigate(PopupPath.SETTINGS_WALLETS); onClose(); },
    },
    {
      icon: 'i-lucide-settings',
      label: 'settings',
      onClick: () => { navigate(PopupPath.SETTINGS); onClose(); },
    },
    ...(inSidePanel
      ? [{
          icon: 'i-lucide-panel-right',
          label: 'open as popup',
          onClick: handleOpenPopupWindow,
        }]
      : []),
    {
      icon: 'i-lucide-lock',
      label: 'lock',
      onClick: handleLock,
      className: 'text-destructive',
    },
  ];

  return (
    <>
      {/* backdrop */}
      <div
        className='fixed inset-0 z-50 bg-black/60 backdrop-blur-sm'
        onClick={onClose}
      />

      {/* drawer */}
      <div className='fixed right-0 top-0 bottom-0 z-50 w-64 bg-background border-l border-border/40 shadow-xl flex flex-col'>
        {/* header */}
        <div className='flex items-center justify-between px-4 py-3 border-b border-border/40'>
          <span className='font-medium'>zafu</span>
          <button onClick={onClose} className='p-1 rounded-lg hover:bg-muted/50 transition-colors'>
            <span className='i-lucide-x h-4 w-4' />
          </button>
        </div>

        {/* zid */}
        {zidAddress && (
          <button
            onClick={() => {
              void navigator.clipboard.writeText(zidPubkey!);
              setZidCopied(true);
              setTimeout(() => setZidCopied(false), 1500);
            }}
            className='mx-4 mt-3 flex items-center gap-2 rounded-lg border border-border/40 px-3 py-2 text-left hover:bg-muted/50 transition-colors'
          >
            <span className='i-lucide-fingerprint h-3.5 w-3.5 text-muted-foreground' />
            <span className='text-xs font-mono text-muted-foreground truncate'>{zidAddress}</span>
            <span className='text-[10px] text-muted-foreground/60 ml-auto'>
              {zidCopied ? 'copied' : 'zid'}
            </span>
          </button>
        )}

        {/* menu items */}
        <nav className='p-2'>
          {menuItems.map((item, i) => (
            <button
              key={i}
              onClick={item.onClick}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors hover:bg-muted/50',
                item.className
              )}
            >
              <span className={cn(item.icon, 'h-4 w-4')} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {/* footer  - donate + about */}
        <div className='mt-auto border-t border-border/40 px-4 py-3'>
          {donation && (
            <button
              onClick={handleDonate}
              className='flex w-full items-center gap-2 px-3 py-2 mb-3 rounded-lg border border-border/40 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors'
            >
              <span className='i-lucide-heart h-3.5 w-3.5' />
              <span>donate {activeNetwork}</span>
            </button>
          )}

          <div className='flex items-center gap-3 text-[10px] text-muted-foreground'>
            <a href='https://rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-foreground'>rotko.net</a>
            <a href='https://github.com/rotkonetworks/zafu' target='_blank' rel='noopener noreferrer' className='hover:text-foreground'>github</a>
            <a href='https://zigner.rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-foreground'>zigner</a>
          </div>
          <p className='text-[9px] text-muted-foreground/50 mt-1'>GPL-3.0</p>
        </div>
      </div>
    </>
  );
};
