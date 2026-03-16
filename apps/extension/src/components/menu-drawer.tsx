/**
 * slide-out menu drawer
 * includes navigation, about info, and donation address
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { selectLock, selectActiveNetwork } from '../state/keyring';
import { PopupPath } from '../routes/popup/paths';
import { cn } from '@repo/ui/lib/utils';
import { isSidePanel } from '../utils/popup-detection';

const DONATION_ADDRESS = 'u153khs43zxz6hcnlwnut77knyqmursnutmungxjxd7khruunhj77ea6tmpzxct9wzlgen66jxwc93ea053j22afkktu7hrs9rmsz003h3';

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const MenuDrawer = ({ open, onClose }: MenuDrawerProps) => {
  const navigate = useNavigate();
  const lock = useStore(selectLock);
  const activeNetwork = useStore(selectActiveNetwork);
  const inSidePanel = isSidePanel();
  const [copied, setCopied] = useState(false);

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

  const handleDonate = useCallback(() => {
    if (activeNetwork === 'zcash') {
      onClose();
      navigate(PopupPath.SEND, { state: { prefillRecipient: DONATION_ADDRESS } });
    } else {
      void navigator.clipboard.writeText(DONATION_ADDRESS);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [activeNetwork, navigate, onClose]);

  if (!open) return null;

  const menuItems = [
    {
      icon: 'i-lucide-user',
      label: 'Contacts',
      onClick: () => { navigate(PopupPath.CONTACTS); onClose(); },
    },
    {
      icon: 'i-lucide-globe',
      label: 'Manage Networks',
      onClick: () => { navigate(PopupPath.SETTINGS_NETWORKS); onClose(); },
    },
    {
      icon: 'i-lucide-wallet',
      label: 'Wallets',
      onClick: () => { navigate(PopupPath.SETTINGS_WALLETS); onClose(); },
    },
    {
      icon: 'i-lucide-settings',
      label: 'Settings',
      onClick: () => { navigate(PopupPath.SETTINGS); onClose(); },
    },
    ...(inSidePanel
      ? [{
          icon: 'i-lucide-panel-right',
          label: 'Open as Popup',
          onClick: handleOpenPopupWindow,
        }]
      : []),
    {
      icon: 'i-lucide-lock',
      label: 'Lock Wallet',
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

        {/* about + donate — pushed to bottom */}
        <div className='mt-auto border-t border-border/40 px-4 py-3'>
          {/* donate */}
          <button
            onClick={handleDonate}
            className='w-full rounded-lg border border-border/40 bg-card px-3 py-2 mb-3 text-left hover:bg-muted/50 transition-colors'
          >
            <p className='text-[10px] text-muted-foreground'>donate zcash</p>
            <p className='text-[9px] font-mono text-muted-foreground/70 truncate mt-0.5'>{DONATION_ADDRESS}</p>
            <p className='text-[10px] text-primary mt-1'>
              {activeNetwork === 'zcash' ? 'tap to send' : copied ? 'copied!' : 'tap to copy'}
            </p>
          </button>

          {/* about links */}
          <div className='flex items-center gap-3 text-[10px] text-muted-foreground'>
            <a href='https://rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-foreground'>rotko.net</a>
            <a href='https://github.com/rotkonetworks/zafu' target='_blank' rel='noopener noreferrer' className='hover:text-foreground'>github</a>
            <a href='https://zigner.rotko.net' target='_blank' rel='noopener noreferrer' className='hover:text-foreground'>zigner</a>
          </div>
          <p className='text-[9px] text-muted-foreground/50 mt-1'>MIT license — rotko networks</p>
        </div>
      </div>
    </>
  );
};
