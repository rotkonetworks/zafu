/**
 * accounts sheet - wallet 1's accounts, cold signers, add wallet, lock, open
 * in window. Pockets (named sub-accounts within a wallet) are not
 * implemented yet, so this lists only the real accounts the keyring already
 * has - no placeholder "pocket" rows, no fake balances.
 */

import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@repo/ui/lib/utils';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../state';
import {
  selectEffectiveKeyInfo,
  selectKeyInfosForActiveNetwork,
  selectSelectKeyRing,
  selectLock,
} from '../state/keyring';
import { isIdentityEnabled } from '../state/privacy';
import { PopupPath } from '../routes/popup/paths';
import { screenTransition } from '../utils/navigate';
import { isSidePanel } from '../utils/popup-detection';
import { CustodyBadge } from './custody-badge';

export const AccountsSheet = ({
  open,
  onOpenChange,
  onAddWallet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the add-wallet sheet replaces this one rather than stacking on top of
   * it (see the canvas "nothing expands in place" rule - two bottom sheets
   * at once would overlap at the same fixed position), so the parent owns
   * that sheet and switches to it here. */
  onAddWallet: () => void;
}) => {
  const navigate = useNavigate();
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  // perf: .filter()s a new array every read - shallow-equal it so this
  // sheet's subscription doesn't re-render on unrelated state ticks.
  const keyInfos = useStore(useShallow(selectKeyInfosForActiveNetwork));
  const selectKeyRing = useStore(selectSelectKeyRing);
  const lock = useStore(selectLock);
  const identityEnabled = useStore(isIdentityEnabled);
  const inSidePanel = isSidePanel();

  const pickWallet = (id: string) => {
    if (id !== selectedKeyInfo?.id) {
      void selectKeyRing(id);
    }
    onOpenChange(false);
  };

  const go = (path: string) => {
    onOpenChange(false);
    navigate(path, screenTransition('push'));
  };

  const handleLock = () => {
    lock();
    onOpenChange(false);
    navigate(PopupPath.LOGIN);
  };

  const handleOpenPopupWindow = async () => {
    onOpenChange(false);
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title='accounts'>
      <div className='flex flex-col gap-4'>
        <div className='flex flex-col divide-y divide-surface-border-soft border border-surface-border-soft bg-surface-elev-1'>
          {keyInfos.length === 0 ? (
            <span className='px-3.5 py-3 text-data text-fg-muted lowercase'>no wallets</span>
          ) : (
            keyInfos.map(k => {
              const active = k.id === selectedKeyInfo?.id;
              return (
                <button
                  key={k.id}
                  type='button'
                  onClick={() => pickWallet(k.id)}
                  className='flex min-h-[52px] items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-surface-elev-2'
                >
                  <span
                    className={cn(
                      'flex size-[18px] shrink-0 items-center justify-center border',
                      active ? 'border-zigner-gold' : 'border-surface-border',
                    )}
                    aria-hidden='true'
                  >
                    {active && <span className='size-2 bg-zigner-gold' />}
                  </span>
                  <span className='min-w-0 flex-1 truncate text-data text-fg-high lowercase'>
                    {k.name}
                  </span>
                  <CustodyBadge vault={k} showLabel={false} />
                </button>
              );
            })
          )}
        </div>

        {identityEnabled && (
          <div className='flex flex-col divide-y divide-surface-border-soft border border-surface-border-soft bg-surface-elev-1'>
            <button
              type='button'
              onClick={() => go(PopupPath.IDENTITY)}
              className='flex min-h-[52px] items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-surface-elev-2'
            >
              <span className='i-ph-fingerprint size-5 shrink-0 text-fg-muted' aria-hidden='true' />
              <span className='flex-1 text-data text-fg-high lowercase'>identity</span>
              <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
            </button>
            <button
              type='button'
              onClick={() => go(PopupPath.CONTACTS)}
              className='flex min-h-[52px] items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-surface-elev-2'
            >
              <span className='i-ph-users size-5 shrink-0 text-fg-muted' aria-hidden='true' />
              <span className='flex-1 text-data text-fg-high lowercase'>contacts</span>
              <span className='i-ph-caret-right size-3.5 shrink-0 text-fg-dim' aria-hidden='true' />
            </button>
          </div>
        )}

        <button
          type='button'
          onClick={onAddWallet}
          className='flex min-h-[44px] items-center gap-3 px-1 text-left text-zigner-gold'
        >
          <span className='i-ph-plus size-[18px] shrink-0' aria-hidden='true' />
          <span className='text-data lowercase'>add wallet</span>
        </button>

        <div className='flex gap-2'>
          <button
            type='button'
            onClick={handleLock}
            className='flex h-11 flex-1 items-center justify-center gap-2 border border-surface-border bg-surface-elev-2 text-data text-fg-high transition-colors hover:bg-surface-border-soft'
          >
            <span className='i-ph-lock size-[15px]' aria-hidden='true' />
            lock
          </button>
          {inSidePanel && (
            <button
              type='button'
              onClick={() => void handleOpenPopupWindow()}
              className='flex h-11 flex-1 items-center justify-center gap-2 border border-surface-border bg-surface-elev-2 text-data text-fg-high transition-colors hover:bg-surface-border-soft'
            >
              <span className='i-ph-arrow-square-out size-[15px]' aria-hidden='true' />
              open in window
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
};
