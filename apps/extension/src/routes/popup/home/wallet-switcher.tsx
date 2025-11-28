import { useStore } from '../../../state';
import { walletsSelector, getActiveWalletJson } from '../../../state/wallets';
import { useState } from 'react';
import { LockClosedIcon, EyeOpenIcon, PlusIcon, ChevronDownIcon } from '@radix-ui/react-icons';
import { usePopupNav } from '../../../utils/navigate';
import { PopupPath } from '../paths';

/**
 * Wallet switcher dropdown component
 *
 * Allows users to switch between hot (seed phrase) and cold (airgap signer) wallets.
 * Shows an icon indicating wallet type:
 * - Lock icon = hot wallet (has spending key)
 * - Eye icon = watch-only wallet (cold/airgap signer)
 */
export const WalletSwitcher = () => {
  const { all, activeIndex, setActiveWallet } = useStore(walletsSelector);
  const activeWallet = useStore(getActiveWalletJson);
  const [open, setOpen] = useState(false);
  const navigate = usePopupNav();

  if (!activeWallet) {
    return null;
  }

  const handleSelect = (index: number) => {
    if (index !== activeIndex) {
      void setActiveWallet(index);
    }
    setOpen(false);
  };

  const handleAddZigner = () => {
    setOpen(false);
    navigate(PopupPath.SETTINGS_ZIGNER);
  };

  return (
    <div className='relative'>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className='flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-white/10 transition-colors'
      >
        <WalletTypeIcon custody={activeWallet.custody} />
        <span className='truncate max-w-[100px]'>{activeWallet.label}</span>
        <ChevronDownIcon className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown menu */}
      {open && (
        <>
          {/* Backdrop to close on click outside */}
          <div
            className='fixed inset-0 z-40'
            onClick={() => setOpen(false)}
          />

          {/* Dropdown content */}
          <div className='absolute top-full left-0 z-50 mt-1 min-w-[180px] rounded-md border border-border bg-background shadow-lg'>
            {/* Wallet list */}
            <div className='py-1'>
              {all.map((wallet, index) => (
                <button
                  key={wallet.id}
                  onClick={() => handleSelect(index)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-white/10 transition-colors ${
                    index === activeIndex ? 'bg-white/5' : ''
                  }`}
                >
                  <WalletTypeIcon custody={wallet.custody} />
                  <span className='truncate flex-1 text-left'>{wallet.label}</span>
                  {isWatchOnly(wallet.custody) && (
                    <span className='text-xs text-yellow-500'>watch</span>
                  )}
                  {index === activeIndex && (
                    <span className='text-xs text-green-500'>active</span>
                  )}
                </button>
              ))}
            </div>

            {/* Divider */}
            <div className='border-t border-border' />

            {/* Add Zigner wallet option */}
            <div className='py-1'>
              <button
                onClick={handleAddZigner}
                className='flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-white/10 hover:text-foreground transition-colors'
              >
                <PlusIcon className='size-4' />
                <span>Add Zigner Wallet</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/**
 * Icon indicating wallet type
 */
const WalletTypeIcon = ({ custody }: { custody: WalletCustody }) => {
  if (isWatchOnly(custody)) {
    return <EyeOpenIcon className='size-4 text-yellow-500' />;
  }
  return <LockClosedIcon className='size-4 text-green-500' />;
};

type WalletCustody =
  | { encryptedSeedPhrase: { cipherText: string; nonce: string } }
  | { airgapSigner: { cipherText: string; nonce: string } };

function isWatchOnly(custody: WalletCustody): boolean {
  return 'airgapSigner' in custody;
}
