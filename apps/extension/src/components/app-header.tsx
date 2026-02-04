/**
 * persistent app header with network/wallet selectors and menu
 * solidjs-style: atomic selectors, composable primitives
 */

import { ChevronDownIcon, HamburgerMenuIcon, PlusIcon, TrashIcon } from '@radix-ui/react-icons';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useStore } from '../state';
import { PopupPath } from '../routes/popup/paths';
import {
  selectActiveNetwork,
  selectEnabledNetworks,
  selectSetActiveNetwork,
  selectEffectiveKeyInfo,
  selectKeyInfosForActiveNetwork,
  selectSelectKeyRing,
  selectKeyInfos,
  keyRingSelector,
} from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { CheckIcon } from '@radix-ui/react-icons';
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
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const keyInfos = useStore(selectKeyInfosForActiveNetwork);
  const allKeyInfos = useStore(selectKeyInfos); // all wallets, not filtered by network
  const selectKeyRing = useStore(selectSelectKeyRing);
  const { deleteKeyRing } = useStore(keyRingSelector);
  const activeZcashWallet = useStore(selectActiveZcashWallet);

  // State for delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (vaultId: string, close: () => void) => {
    try {
      setDeleting(true);
      await deleteKeyRing(vaultId);
      setConfirmDeleteId(null);
      close();
    } catch (err) {
      console.error('Failed to delete wallet:', err);
    } finally {
      setDeleting(false);
    }
  };

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
          <div className='absolute left-1/2 -translate-x-1/2 top-full mt-1 z-50 min-w-[180px] max-h-[300px] overflow-y-auto rounded border border-border bg-popover p-1 shadow-lg'>
            {keyInfos.length > 0 && (
              <>
                <div className='px-2 py-1 text-xs text-muted-foreground font-medium'>
                  wallets
                </div>
                {keyInfos.map(keyInfo => {
                  const isActive = keyInfo.id === selectedKeyInfo?.id;
                  // Find the original (first created) wallet - cannot be deleted
                  const oldestCreatedAt = Math.min(...allKeyInfos.map(k => k.createdAt));
                  const isOriginal = keyInfo.createdAt === oldestCreatedAt;
                  // Can only delete if: 1) more than one wallet, 2) more than one for current network, 3) not the original
                  const canDelete = allKeyInfos.length > 1 && keyInfos.length > 1 && !isOriginal;
                  const isConfirming = confirmDeleteId === keyInfo.id;

                  if (isConfirming) {
                    return (
                      <div
                        key={keyInfo.id}
                        className='flex flex-col gap-1 px-2 py-1.5 text-sm rounded bg-destructive/10 border border-destructive/30'
                      >
                        <span className='text-xs text-destructive'>Delete "{keyInfo.name}"?</span>
                        <div className='flex gap-1'>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            disabled={deleting}
                            className='flex-1 px-2 py-0.5 text-xs rounded bg-muted hover:bg-muted/80'
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => void handleDelete(keyInfo.id, close)}
                            disabled={deleting}
                            className='flex-1 px-2 py-0.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/90'
                          >
                            {deleting ? '...' : 'Delete'}
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={keyInfo.id}
                      className={cn(
                        'group flex w-full items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted/50',
                        isActive && 'bg-muted/50'
                      )}
                    >
                      <button
                        onClick={() => {
                          void selectKeyRing(keyInfo.id);
                          close();
                        }}
                        className='flex flex-1 items-center gap-2 min-w-0'
                      >
                        {isActive ? (
                          <CheckIcon className='h-3 w-3 text-primary flex-shrink-0' />
                        ) : (
                          <div className='h-3 w-3 flex-shrink-0' />
                        )}
                        <span className='truncate'>{keyInfo.name}</span>
                        <span className='ml-auto text-xs text-muted-foreground flex-shrink-0'>
                          {keyInfo.type === 'mnemonic' ? 'seed' : 'zigner'}
                        </span>
                      </button>
                      {canDelete && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(keyInfo.id);
                          }}
                          className='p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-opacity'
                          title='Delete wallet'
                        >
                          <TrashIcon className='h-3 w-3' />
                        </button>
                      )}
                    </div>
                  );
                })}
                <div className='border-t border-border/40 my-1' />
              </>
            )}
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
