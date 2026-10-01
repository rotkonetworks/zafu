/**
 * accounts sheet (Accounts.dc.html) - the hot wallet's pockets, other
 * wallets and cold signers, add wallet, then lock and open in window.
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
import { MAX_POCKETS, activeAccountIndex, activePockets, pocketOwner } from '../state/pockets';
import { pocketStoreId } from '../state/pocket-id';
import { getBalanceInWorker } from '../state/keyring/network-worker';
import { PopupPath } from '../routes/popup/paths';
import { isSidePanel } from '../utils/popup-detection';
import { custodyOf, type Custody } from './custody-badge';
import { Mark } from '@repo/ui/components/ui/mark';
import { Button } from '@repo/ui/components/ui/button';
import { Sensitive } from './sensitive';
import { fmtZec } from '../routes/popup/home/format';

const CUSTODY_META: Record<Custody, string> = {
  hot: 'hot · this device',
  cold: 'cold · signs on its device',
  shared: 'shared · co-signers approve',
};

const CUSTODY_ICON: Record<Custody, string> = {
  hot: 'i-zafu-hi text-zigner-gold',
  cold: 'i-zafu-kori text-zafu-blue',
  shared: 'i-zafu-torii text-fg-muted',
};

/** what the new-pocket sheet should do: create a fresh pocket, or rename an existing one */
export type PocketSheetTarget = { account: number; name: string } | undefined;

const PocketRow = ({
  name,
  account,
  active,
  balanceZat,
  onPick,
  onRename,
}: {
  name: string;
  account: number;
  active: boolean;
  balanceZat: bigint | undefined;
  onPick: () => void;
  onRename: () => void;
}) => (
  <div className='flex items-center'>
    <button
      type='button'
      onClick={onPick}
      className='flex h-[54px] flex-1 items-center gap-3 px-2 text-left transition-colors hover:bg-surface-elev-2'
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
      <span className='flex min-w-0 flex-1 flex-col gap-[3px]'>
        <span className='truncate text-sm text-fg-high lowercase'>{name}</span>
        <span className='truncate text-[11px] text-fg-muted lowercase'>account {account}</span>
      </span>
      {active && balanceZat !== undefined && (
        <Sensitive className='shrink-0 tabular-nums text-sm text-fg-high'>
          {fmtZec(Number(balanceZat) / 1e8)}
        </Sensitive>
      )}
    </button>
    <button
      type='button'
      onClick={onRename}
      aria-label={`rename ${name}`}
      className='flex size-11 shrink-0 items-center justify-center text-fg-muted transition-colors hover:text-fg-high'
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
    <Sheet open={open} onOpenChange={onOpenChange} title='accounts' className='gap-0 pb-0'>
      {isHotWallet && selectedKeyInfo && (
        <div className='-mx-4 flex flex-col px-3 pb-2'>
          <div className='flex items-center gap-2 px-2 pb-1.5'>
            <Mark variant='seal' size={20} />
            <span className='truncate text-[13px] text-fg-high lowercase'>
              {selectedKeyInfo.name}
            </span>
            <span className='text-[11px] text-fg-muted'>{CUSTODY_META.hot}</span>
          </div>
          {pockets.map(p => (
            <PocketRow
              key={p.account}
              name={p.name}
              account={p.account}
              active={p.account === activeAccount}
              balanceZat={activeBalanceZat}
              onPick={() => pickPocket(p.account)}
              onRename={() => onNewPocket({ account: p.account, name: p.name })}
            />
          ))}
          <Plus
            label={
              pockets.length >= MAX_POCKETS
                ? `this wallet has ${MAX_POCKETS} pockets, the most it can hold`
                : 'new pocket'
            }
            tone='text-zigner-gold'
            disabled={pockets.length >= MAX_POCKETS}
            onClick={() => onNewPocket()}
          />
        </div>
      )}

      <div className='-mx-4 flex flex-col border-t border-border-soft px-3 pb-3.5 pt-2.5'>
        {otherKeyInfos.map(k => {
          const custody = custodyOf(k.type);
          return (
            <button
              key={k.id}
              type='button'
              onClick={() => pickWallet(k.id)}
              className='flex h-[54px] items-center gap-3 px-2 text-left transition-colors hover:bg-surface-elev-2'
            >
              <span
                className={cn('size-[18px] shrink-0', CUSTODY_ICON[custody])}
                aria-hidden='true'
              />
              <span className='flex min-w-0 flex-1 flex-col gap-[3px]'>
                <span className='truncate text-sm text-fg-high lowercase'>{k.name}</span>
                <span className='truncate text-[11px] text-fg-muted'>{CUSTODY_META[custody]}</span>
              </span>
            </button>
          );
        })}
        <Plus label='add wallet' tone='text-fg-muted' onClick={onAddWallet} />
      </div>

      <div className='-mx-4 flex gap-2 border-t border-border-soft px-5 pb-4 pt-3'>
        <Button variant='secondary' className='h-11 flex-1 text-[13px]' onClick={handleLock}>
          <span className='i-ph-lock size-[15px]' aria-hidden='true' />
          lock
        </Button>
        {inSidePanel && (
          <Button
            variant='secondary'
            className='h-11 flex-1 text-[13px]'
            onClick={() => void handleOpenPopupWindow()}
          >
            <span className='i-ph-arrow-square-out size-[15px]' aria-hidden='true' />
            open in window
          </Button>
        )}
      </div>
    </Sheet>
  );
};

const Plus = ({
  label,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  tone: string;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <button
    type='button'
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'flex h-11 items-center gap-3 px-2 text-left text-[13px] transition-colors hover:bg-surface-elev-2 disabled:pointer-events-none disabled:opacity-50',
      tone,
    )}
  >
    <span className='i-ph-plus size-[18px] shrink-0' aria-hidden='true' />
    {label}
  </button>
);
