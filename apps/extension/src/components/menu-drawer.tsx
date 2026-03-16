/**
 * slide-out menu drawer
 * solidjs-style: atomic selectors, minimal state
 */

import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { selectLock } from '../state/keyring';
import { PopupPath } from '../routes/popup/paths';
import { cn } from '@repo/ui/lib/utils';
import { isSidePanel } from '../utils/popup-detection';

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const MenuDrawer = ({ open, onClose }: MenuDrawerProps) => {
  const navigate = useNavigate();
  const lock = useStore(selectLock);
  const inSidePanel = isSidePanel();

  if (!open) return null;

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

  const menuItems = [
    {
      icon: 'i-lucide-user',
      label: 'Contacts',
      onClick: () => {
        navigate(PopupPath.CONTACTS);
        onClose();
      },
    },
    {
      icon: 'i-lucide-globe',
      label: 'Manage Networks',
      onClick: () => {
        navigate(PopupPath.SETTINGS_NETWORKS);
        onClose();
      },
    },
    {
      icon: 'i-lucide-wallet',
      label: 'Wallets',
      onClick: () => {
        navigate(PopupPath.SETTINGS_WALLETS);
        onClose();
      },
    },
    {
      icon: 'i-lucide-settings',
      label: 'Settings',
      onClick: () => {
        navigate(PopupPath.SETTINGS);
        onClose();
      },
    },
    ...(inSidePanel
      ? [
          {
            icon: 'i-lucide-panel-right',
            label: 'Open as Popup',
            onClick: handleOpenPopupWindow,
          },
        ]
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
      <div className='fixed right-0 top-0 bottom-0 z-50 w-64 bg-background border-l border-border/40 shadow-xl'>
        {/* header */}
        <div className='flex items-center justify-between px-4 py-3 border-b border-border/40'>
          <span className='font-medium'>Menu</span>
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
      </div>
    </>
  );
};
