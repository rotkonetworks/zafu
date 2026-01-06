import { useStore } from '../../../state';
import { walletsSelector, getActiveWalletJson } from '../../../state/wallets';
import { useState, useRef, useEffect } from 'react';
import { LockClosedIcon, EyeOpenIcon, PlusIcon, ChevronDownIcon, GearIcon } from '@radix-ui/react-icons';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';
import { cn } from '@repo/ui/lib/utils';

/**
 * keplr-style wallet switcher with grouped wallets - 90s volvo pragmatic
 */
export const WalletSwitcher = () => {
  const { all, activeIndex, setActiveWallet } = useStore(walletsSelector);
  const activeWallet = useStore(getActiveWalletJson);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = usePopupNav();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!activeWallet) {
    return null;
  }

  // group wallets by type
  const zignerWallets = all
    .map((w, i) => ({ ...w, index: i }))
    .filter(w => 'airgapSigner' in w.custody);
  const hotWallets = all
    .map((w, i) => ({ ...w, index: i }))
    .filter(w => 'encryptedSeedPhrase' in w.custody);

  const handleSelect = (index: number) => {
    if (index !== activeIndex) {
      void setActiveWallet(index);
    }
    setOpen(false);
  };

  const isZigner = 'airgapSigner' in activeWallet.custody;

  return (
    <div ref={containerRef} className='relative'>
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 text-sm',
          'transition-colors duration-75 hover:bg-accent'
        )}
      >
        <div className={cn(
          'flex h-6 w-6 items-center justify-center text-xs font-medium',
          isZigner ? 'bg-zigner-gold/20 text-zigner-gold' : 'bg-success/20 text-success'
        )}>
          {isZigner ? <EyeOpenIcon className='h-3.5 w-3.5' /> : <LockClosedIcon className='h-3.5 w-3.5' />}
        </div>
        <span className='max-w-[100px] truncate font-medium'>{activeWallet.label}</span>
        <ChevronDownIcon className={cn('h-4 w-4 text-muted-foreground transition-transform duration-75', open && 'rotate-180')} />
      </button>

      {open && (
        <div className='absolute left-0 top-full z-50 mt-1 w-56 border border-border bg-popover shadow-lg'>
          {/* zigner wallets */}
          {zignerWallets.length > 0 && (
            <div className='p-1'>
              <div className='px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground'>
                zigner zafu
              </div>
              {zignerWallets.map(wallet => (
                <WalletRow
                  key={wallet.id}
                  label={wallet.label}
                  isActive={wallet.index === activeIndex}
                  isZigner={true}
                  onClick={() => handleSelect(wallet.index)}
                />
              ))}
            </div>
          )}

          {/* hot wallets */}
          {hotWallets.length > 0 && (
            <div className={cn('p-1', zignerWallets.length > 0 && 'border-t border-border')}>
              <div className='px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground'>
                hot wallets
              </div>
              {hotWallets.map(wallet => (
                <WalletRow
                  key={wallet.id}
                  label={wallet.label}
                  isActive={wallet.index === activeIndex}
                  isZigner={false}
                  onClick={() => handleSelect(wallet.index)}
                />
              ))}
            </div>
          )}

          {/* actions */}
          <div className='border-t border-border p-1'>
            <button
              onClick={() => {
                setOpen(false);
                navigate(PopupPath.SETTINGS_ZIGNER);
              }}
              className='flex w-full items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-75 hover:bg-accent hover:text-foreground'
            >
              <PlusIcon className='h-4 w-4' />
              <span>add zigner zafu</span>
            </button>
            <button
              onClick={() => {
                setOpen(false);
                navigate(PopupPath.SETTINGS);
              }}
              className='flex w-full items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-75 hover:bg-accent hover:text-foreground'
            >
              <GearIcon className='h-4 w-4' />
              <span>settings</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

interface WalletRowProps {
  label: string;
  isActive: boolean;
  isZigner: boolean;
  onClick: () => void;
}

const WalletRow = ({ label, isActive, isZigner, onClick }: WalletRowProps) => (
  <button
    onClick={onClick}
    className={cn(
      'flex w-full items-center gap-2 px-2 py-1.5 text-sm transition-colors duration-75',
      isActive ? 'bg-accent' : 'hover:bg-accent/50'
    )}
  >
    <div className={cn(
      'flex h-5 w-5 items-center justify-center text-xs',
      isZigner ? 'bg-zigner-gold/20 text-zigner-gold' : 'bg-success/20 text-success'
    )}>
      {isZigner ? <EyeOpenIcon className='h-3 w-3' /> : <LockClosedIcon className='h-3 w-3' />}
    </div>
    <span className='flex-1 truncate text-left'>{label}</span>
    {isActive && (
      <div className='h-1.5 w-1.5 bg-primary' />
    )}
  </button>
);
