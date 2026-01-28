/**
 * slide-out menu drawer
 * solidjs-style: atomic selectors, minimal state
 */

import { useNavigate } from 'react-router-dom';
import {
  Cross1Icon,
  PersonIcon,
  GlobeIcon,
  LockClosedIcon,
  QuestionMarkCircledIcon,
  MobileIcon,
  GearIcon,
} from '@radix-ui/react-icons';
import { useStore } from '../state';
import { selectLock } from '../state/keyring';
import { PopupPath } from '../routes/popup/paths';
import { cn } from '@repo/ui/lib/utils';

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
}

export const MenuDrawer = ({ open, onClose }: MenuDrawerProps) => {
  const navigate = useNavigate();
  const lock = useStore(selectLock);

  // don't render anything when closed
  if (!open) return null;

  const handleLock = () => {
    lock();
    onClose();
    navigate(PopupPath.LOGIN);
  };

  const menuItems = [
    {
      icon: <PersonIcon className='h-4 w-4' />,
      label: 'Contacts',
      onClick: () => {
        navigate(PopupPath.CONTACTS);
        onClose();
      },
    },
    {
      icon: <GlobeIcon className='h-4 w-4' />,
      label: 'Manage Networks',
      onClick: () => {
        navigate(PopupPath.SETTINGS_NETWORKS);
        onClose();
      },
    },
    {
      icon: <MobileIcon className='h-4 w-4' />,
      label: 'Zigner',
      onClick: () => {
        navigate(PopupPath.SETTINGS_ZIGNER);
        onClose();
      },
    },
    {
      icon: <QuestionMarkCircledIcon className='h-4 w-4' />,
      label: 'About',
      onClick: () => {
        navigate(PopupPath.SETTINGS_ABOUT);
        onClose();
      },
    },
    {
      icon: <GearIcon className='h-4 w-4' />,
      label: 'Settings',
      onClick: () => {
        navigate(PopupPath.SETTINGS);
        onClose();
      },
    },
    {
      icon: <LockClosedIcon className='h-4 w-4' />,
      label: 'Lock Wallet',
      onClick: handleLock,
      className: 'text-destructive',
    },
  ];

  return (
    <>
      {/* backdrop */}
      <div
        className='fixed inset-0 z-50 bg-black/50'
        onClick={onClose}
      />

      {/* drawer */}
      <div className='fixed right-0 top-0 bottom-0 z-50 w-64 bg-background border-l border-border shadow-xl'>
        {/* header */}
        <div className='flex items-center justify-between px-4 py-3 border-b border-border'>
          <span className='font-medium'>Menu</span>
          <button onClick={onClose} className='p-1 rounded hover:bg-muted/50'>
            <Cross1Icon className='h-4 w-4' />
          </button>
        </div>

        {/* menu items */}
        <nav className='p-2'>
          {menuItems.map((item, i) => (
            <button
              key={i}
              onClick={item.onClick}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-2.5 rounded text-sm transition-colors hover:bg-muted/50',
                item.className
              )}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </>
  );
};
