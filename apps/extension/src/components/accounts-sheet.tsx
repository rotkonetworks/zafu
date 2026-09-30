/**
 * accounts sheet - the hot wallet's pockets, other accounts, cold signers,
 * add wallet, lock, open in window.
 */

import { useEffect, useState } from 'react';
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
import { MAX_POCKETS, activeAccountIndex, activePockets, pocketOwner } from '../state/pockets';
import { pocketStoreId } from '../state/pocket-id';
import { getBalanceInWorker } from '../state/keyring/network-worker';
import { PopupPath } from '../routes/popup/paths';
import { screenTransition } from '../utils/navigate';
import { isSidePanel } from '../utils/popup-detection';
import { CustodyBadge } from './custody-badge';
import { Sensitive } from './sensitive';
import { fmtZec } from '../routes/popup/home/format';

/** what the new-pocket sheet should do: create a fresh pocket, or rename an existing one */
export type PocketSheetTarget = { account: number; name: string } | undefined;

const PocketRow = ({
  name,
  account,
  active,
  canSync,
  balanceZat,
  onPick,
  onRename,
}: {
  name: string;
  account: number;
  active: boolean;
  /** only account 0 can scan until a newer zafu-wasm ships pocket derivation */
  canSync: boolean;
  balanceZat: bigint | undefined;
  onPick: () => void;
  onRename: () => void;
}) => (
  <div className='flex items-center'>
    <button
      type='button'
      onClick={onPick}
      className='flex min-h-[52px] flex-1 items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-surface-elev-2'
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
      <span className='flex min-w-0 flex-1 flex-col gap-0.5'>
        <span className='truncate text-data text-fg-high lowercase'>{name}</span>
        <span className='truncate text-label text-fg-muted lowercase'>
          {canSync ? `account ${account}` : `account ${account} - starts syncing once zafu updates`}
        </span>
      </span>
      {active && canSync && balanceZat !== undefined && (
        <Sensitive className='shrink-0 tabular-nums text-data text-fg-high'>
          {fmtZec(Number(balanceZat) / 1e8)} ZEC
        </Sensitive>
      )}
    </button>
    <button
      type='button'
      onClick={onRename}
      aria-label={`rename ${name}`}
      className='flex size-11 shrink-0 items-center justify-center text-fg-dim transition-colors hover:text-fg-high'
    >
      <span className='i-ph-pencil-simple size-4' aria-hidden='true' />
    </button>
  </div>
);

export const AccountsSheet = ({
  open,
  onOpenChange,
  onAddWallet,
  onNewPocket,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the add-wallet sheet replaces this one rather than stacking on top of
   * it (see the canvas "nothing expands in place" rule - two bottom sheets
   * at once would overlap at the same fixed position), so the parent owns
   * that sheet and switches to it here. */
  onAddWallet: () => void;
  /** same pattern: the new-pocket sheet replaces this one, in create mode
   * (no argument) or rename mode (the pocket being renamed). */
  onNewPocket: (rename?: PocketSheetTarget) => void;
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

  const isHotWallet = selectedKeyInfo?.type === 'mnemonic';
  // the active hot wallet gets its own header + pockets block above; listing
  // it again here would be the same wallet twice, and tapping it would do
  // nothing (it is already selected).
  const otherKeyInfos = isHotWallet ? keyInfos.filter(k => k.id !== selectedKeyInfo?.id) : keyInfos;
  const pockets = useStore(useShallow(activePockets));
  const activeAccount = useStore(activeAccountIndex);
  const selectPocket = useStore(s => s.pockets.select);
  const [activeBalanceZat, setActiveBalanceZat] = useState<bigint>();

  useEffect(() => {
    if (!open || !isHotWallet || !selectedKeyInfo) {
      return;
    }
    let cancelled = false;
    getBalanceInWorker('zcash', pocketStoreId(selectedKeyInfo.id, activeAccount))
      .then(bal => {
        if (!cancelled) {
          setActiveBalanceZat(BigInt(bal));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActiveBalanceZat(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, isHotWallet, selectedKeyInfo, activeAccount]);

  const pickWallet = (id: string) => {
    if (id !== selectedKeyInfo?.id) {
      void selectKeyRing(id);
    }
    onOpenChange(false);
  };

  const pickPocket = (account: number) => {
    if (!selectedKeyInfo) {
      return;
    }
    void selectPocket(pocketOwner(selectedKeyInfo), account);
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
        {isHotWallet && selectedKeyInfo && (
          <div className='flex flex-col gap-2'>
            <div className='flex items-center gap-2 px-3.5'>
              <span className='truncate text-label text-fg-muted lowercase'>
                {selectedKeyInfo.name}
              </span>
              <CustodyBadge vault={selectedKeyInfo} showLabel />
            </div>
            <div className='flex flex-col divide-y divide-surface-border-soft border border-surface-border-soft bg-surface-elev-1'>
              {pockets.map(p => (
                <PocketRow
                  key={p.account}
                  name={p.name}
                  account={p.account}
                  active={p.account === activeAccount}
                  canSync={p.account === 0}
                  balanceZat={activeBalanceZat}
                  onPick={() => pickPocket(p.account)}
                  onRename={() => onNewPocket({ account: p.account, name: p.name })}
                />
              ))}
              <button
                type='button'
                onClick={() => onNewPocket()}
                disabled={pockets.length >= MAX_POCKETS}
                className='flex min-h-[44px] items-center gap-3 px-3.5 py-2 text-left text-zigner-gold disabled:pointer-events-none disabled:opacity-50'
              >
                <span className='i-ph-plus size-[18px] shrink-0' aria-hidden='true' />
                <span className='text-data lowercase'>
                  {pockets.length >= MAX_POCKETS
                    ? `this wallet has ${MAX_POCKETS} pockets, the most it can hold`
                    : 'new pocket'}
                </span>
              </button>
            </div>
          </div>
        )}

        <div className='flex flex-col divide-y divide-surface-border-soft border border-surface-border-soft bg-surface-elev-1'>
          {otherKeyInfos.length === 0 ? (
            <span className='px-3.5 py-3 text-data text-fg-muted lowercase'>
              {isHotWallet ? 'no other wallets' : 'no wallets'}
            </span>
          ) : (
            otherKeyInfos.map(k => {
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
