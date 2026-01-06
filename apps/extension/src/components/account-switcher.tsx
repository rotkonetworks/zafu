/**
 * keplr-style account switcher floating modal
 */

import { useState, useRef, useEffect } from 'react';
import { useStore } from '../state';
import { keyRingSelector, KeyInfo } from '../state/keyring';
import { PlusIcon, GearIcon, PersonIcon } from '@radix-ui/react-icons';
import { usePopupNav } from '../utils/navigate';
import { PopupPath } from '../routes/popup/paths';
import { cn } from '@repo/ui/lib/utils';

interface AccountSwitcherProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement>;
}

export const AccountSwitcher = ({ isOpen, onClose, anchorRef }: AccountSwitcherProps) => {
  const { keyInfos, selectedKeyInfo, selectKeyRing } = useStore(keyRingSelector);
  const navigate = usePopupNav();
  const modalRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');

  // close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        modalRef.current &&
        !modalRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  // close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const filteredKeyInfos = search
    ? keyInfos.filter(k => k.name.toLowerCase().includes(search.toLowerCase()))
    : keyInfos;

  // group by type
  const mnemonicKeys = filteredKeyInfos.filter(k => k.type === 'mnemonic');
  const zignerKeys = filteredKeyInfos.filter(k => k.type === 'zigner-zafu');
  const ledgerKeys = filteredKeyInfos.filter(k => k.type === 'ledger');

  const handleSelect = async (keyInfo: KeyInfo) => {
    if (keyInfo.id === selectedKeyInfo?.id) {
      onClose();
      return;
    }
    await selectKeyRing(keyInfo.id);
    onClose();
  };

  return (
    <div
      ref={modalRef}
      className='absolute left-0 top-full z-50 mt-2 w-72 border border-border bg-popover shadow-lg'
    >
      {/* header */}
      <div className='flex items-center justify-between border-b border-border px-3 py-2'>
        <span className='text-sm font-medium text-foreground'>accounts</span>
        <button
          onClick={() => {
            onClose();
            // open register page in new tab
            void chrome.tabs.create({ url: '/page.html#/onboarding' });
          }}
          className='p-1 text-muted-foreground transition-colors duration-75 hover:bg-accent hover:text-foreground'
        >
          <PlusIcon className='h-4 w-4' />
        </button>
      </div>

      {/* search (only show if 7+ accounts) */}
      {keyInfos.length >= 7 && (
        <div className='border-b border-border p-2'>
          <input
            type='text'
            placeholder='search accounts...'
            value={search}
            onChange={e => setSearch(e.target.value)}
            className='w-full border border-border bg-input px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-zigner-gold focus:outline-none'
            autoFocus
          />
        </div>
      )}

      {/* account list */}
      <div className='max-h-72 overflow-y-auto p-1'>
        {/* hot wallets */}
        {mnemonicKeys.length > 0 && (
          <AccountGroup label='hot wallets' accounts={mnemonicKeys} selectedId={selectedKeyInfo?.id} onSelect={handleSelect} />
        )}

        {/* zigner zafu */}
        {zignerKeys.length > 0 && (
          <AccountGroup label='zigner zafu' accounts={zignerKeys} selectedId={selectedKeyInfo?.id} onSelect={handleSelect} />
        )}

        {/* ledger */}
        {ledgerKeys.length > 0 && (
          <AccountGroup label='ledger' accounts={ledgerKeys} selectedId={selectedKeyInfo?.id} onSelect={handleSelect} />
        )}

        {filteredKeyInfos.length === 0 && (
          <div className='py-4 text-center text-sm text-muted-foreground'>
            no accounts found
          </div>
        )}
      </div>

      {/* footer actions */}
      <div className='border-t border-border p-1'>
        <button
          onClick={() => {
            onClose();
            navigate(PopupPath.SETTINGS);
          }}
          className='flex w-full items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-75 hover:bg-accent hover:text-foreground'
        >
          <GearIcon className='h-4 w-4' />
          <span>settings</span>
        </button>
      </div>
    </div>
  );
};

interface AccountGroupProps {
  label: string;
  accounts: KeyInfo[];
  selectedId?: string;
  onSelect: (keyInfo: KeyInfo) => void;
}

const AccountGroup = ({ label, accounts, selectedId, onSelect }: AccountGroupProps) => (
  <div className='mb-1'>
    <div className='px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground'>
      {label}
    </div>
    {accounts.map(account => (
      <AccountRow
        key={account.id}
        account={account}
        isSelected={account.id === selectedId}
        onSelect={() => onSelect(account)}
      />
    ))}
  </div>
);

interface AccountRowProps {
  account: KeyInfo;
  isSelected: boolean;
  onSelect: () => void;
}

const AccountRow = ({ account, isSelected, onSelect }: AccountRowProps) => {
  const iconColor = account.type === 'zigner-zafu'
    ? 'bg-zigner-gold/20 text-zigner-gold'
    : account.type === 'ledger'
      ? 'bg-info/20 text-info'
      : 'bg-success/20 text-success';

  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2 px-2 py-1.5 text-sm transition-colors duration-75',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
    >
      <div className={cn('flex h-6 w-6 items-center justify-center', iconColor)}>
        <PersonIcon className='h-3.5 w-3.5' />
      </div>
      <span className='flex-1 truncate text-left text-foreground'>{account.name}</span>
      {isSelected && <div className='h-1.5 w-1.5 bg-zigner-gold' />}
    </button>
  );
};

/** account name display for header */
export const AccountNameButton = ({
  onClick,
  accountRef,
}: {
  onClick: () => void;
  accountRef: React.RefObject<HTMLButtonElement>;
}) => {
  const { selectedKeyInfo } = useStore(keyRingSelector);

  if (!selectedKeyInfo) {
    return (
      <button
        ref={accountRef}
        onClick={onClick}
        className='flex items-center gap-2 px-2 py-1.5 text-sm transition-colors duration-75 hover:bg-accent'
      >
        <div className='flex h-6 w-6 items-center justify-center bg-muted text-muted-foreground'>
          <PersonIcon className='h-3.5 w-3.5' />
        </div>
        <span className='text-muted-foreground'>no account</span>
      </button>
    );
  }

  const iconColor = selectedKeyInfo.type === 'zigner-zafu'
    ? 'bg-zigner-gold/20 text-zigner-gold'
    : selectedKeyInfo.type === 'ledger'
      ? 'bg-info/20 text-info'
      : 'bg-success/20 text-success';

  return (
    <button
      ref={accountRef}
      onClick={onClick}
      className='flex items-center gap-2 px-2 py-1.5 text-sm transition-colors duration-75 hover:bg-accent'
    >
      <div className={cn('flex h-6 w-6 items-center justify-center', iconColor)}>
        <PersonIcon className='h-3.5 w-3.5' />
      </div>
      <span className='max-w-[100px] truncate font-medium text-foreground'>
        {selectedKeyInfo.name}
      </span>
    </button>
  );
};
