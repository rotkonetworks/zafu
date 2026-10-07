/**
 * persistent app header - minimal
 * tap the wallet name  -> Accounts sheet (accounts, cold signers, add wallet, lock)
 * tap the network chip -> Network sheet (switch network, turn one on)
 * lock                 -> locks now, one tap from every screen
 */

import { Clipped } from '@repo/ui/components/ui/clipped';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state';
import { selectActiveNetwork, selectEffectiveKeyInfo, selectLock } from '../state/keyring';
import { useNavigate } from 'react-router-dom';
import { PopupPath } from '../routes/popup/paths';
import { selectActiveZcashWallet } from '../state/wallets';
import { isViewOnly } from '../signing/wallet-kind';
import { activePockets, hiddenPockets, pocketOwner } from '../state/pockets';
import { getNetwork, getRootNetwork } from '../config/networks';
import { AccountsSheet, pocketTarget, type PocketSheetTarget } from './accounts-sheet';
import { NetworkSheet } from './network-sheet';
import { AddWalletSheet } from './add-wallet-sheet';
import { NewPocketSheet } from './new-pocket-sheet';
import { HiddenPocketsSheet } from './hidden-pockets-sheet';
import { MovedSheet } from './moved-sheet';
import { LAST_SEEN_VERSION, showMoved } from '../state/moved-notice';
import { cn } from '@repo/ui/lib/utils';
import { Mark } from '@repo/ui/components/ui/mark';

type OpenSheet =
  | 'accounts'
  | 'network'
  | 'add-wallet'
  | 'new-pocket'
  | 'hidden-pockets'
  | 'moved'
  | null;

export const AppHeader = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const pockets = useStore(useShallow(activePockets));
  const pocketAccount = useStore(pocketTarget(activeNetwork).active);
  const owner = selectedKeyInfo ? pocketOwner(selectedKeyInfo) : undefined;
  const hidden = hiddenPockets(pockets);
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);
  const lock = useStore(selectLock);
  const navigate = useNavigate();
  // set when the new-pocket sheet is opened to rename an existing pocket
  // instead of creating one
  const [renameTarget, setRenameTarget] = useState<PocketSheetTarget>();

  // the first open after the redesign update says what moved, once
  useEffect(() => {
    void chrome.storage.local.get(LAST_SEEN_VERSION).then(r => {
      if (showMoved(r[LAST_SEEN_VERSION], chrome.runtime.getManifest().version)) {
        setOpenSheet(open => open ?? 'moved');
      }
    });
  }, []);
  const seenMoved = (next: OpenSheet) => {
    setOpenSheet(next);
    void chrome.storage.local.set({ [LAST_SEEN_VERSION]: chrome.runtime.getManifest().version });
  };

  // a burner chain is penumbra's plumbing, never a network of its own
  const networkInfo = getNetwork(getRootNetwork(activeNetwork));
  // mnemonic vaults derive zcash keys directly - no zcash wallet record
  const walletName =
    activeNetwork === 'zcash' && selectedKeyInfo?.type !== 'mnemonic'
      ? (activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'no wallet')
      : (selectedKeyInfo?.name ?? 'no wallet');
  const viewOnly = isViewOnly(selectedKeyInfo);
  // pockets exist only for the hot wallet - shows which one is active
  const subtitle =
    pockets.find(p => p.account === pocketAccount)?.name ?? (viewOnly ? 'view only' : undefined);

  return (
    <header className='sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-soft bg-canvas pl-3 pr-2'>
      <button
        data-preload='sheet:wallets'
        onClick={() => setOpenSheet('accounts')}
        className='flex h-10 min-w-0 items-center gap-2.5 pl-1 pr-2.5 transition-colors hover:bg-elev-2'
        aria-label='accounts'
        aria-haspopup='dialog'
      >
        {viewOnly ? (
          <span className='grid size-[26px] shrink-0 place-items-center border border-border-soft'>
            <span className='i-ph-eye size-3.5 text-fg-muted' />
          </span>
        ) : (
          <Mark variant='seal' size={26} />
        )}
        <span className='flex min-w-0 flex-col items-start leading-tight'>
          <Clipped className='max-w-32 text-sm text-fg-high lowercase'>{walletName}</Clipped>
          {subtitle && (
            <Clipped className='max-w-32 text-[11px] text-fg-muted lowercase'>{subtitle}</Clipped>
          )}
        </span>
        <span className='i-lucide-chevron-down size-3.5 shrink-0 text-fg-muted' />
      </button>

      <div className='flex shrink-0 items-center gap-1'>
        <button
          onClick={() => setOpenSheet('network')}
          className='flex h-8 shrink-0 items-center gap-2 border border-border-soft bg-elev-1 px-2.5 transition-colors hover:bg-elev-2'
          aria-label='switch network'
          aria-haspopup='dialog'
        >
          <span className={cn('size-2', networkInfo.color)} />
          <span className='text-[13px] text-fg-high lowercase'>{networkInfo.name}</span>
          <span className='i-lucide-chevron-down size-3 text-fg-muted' />
        </button>
        <button
          onClick={() => {
            lock();
            navigate(PopupPath.LOGIN);
          }}
          className='grid size-10 place-items-center text-fg-muted transition-colors hover:bg-elev-2 hover:text-fg-high'
          aria-label='lock'
          title='lock'
        >
          <span className='i-lucide-lock size-4' />
        </button>
      </div>

      <AccountsSheet
        open={openSheet === 'accounts'}
        onOpenChange={next => setOpenSheet(next ? 'accounts' : null)}
        onAddWallet={() => setOpenSheet('add-wallet')}
        onNewPocket={rename => {
          setRenameTarget(rename);
          setOpenSheet('new-pocket');
        }}
        onHiddenPockets={() => setOpenSheet('hidden-pockets')}
      />
      <NetworkSheet
        open={openSheet === 'network'}
        onOpenChange={next => setOpenSheet(next ? 'network' : null)}
      />
      <AddWalletSheet
        open={openSheet === 'add-wallet'}
        onOpenChange={next => setOpenSheet(next ? 'add-wallet' : null)}
      />
      <NewPocketSheet
        open={openSheet === 'new-pocket'}
        onOpenChange={next => setOpenSheet(next ? 'new-pocket' : null)}
        rename={renameTarget}
      />
      <HiddenPocketsSheet
        open={openSheet === 'hidden-pockets'}
        onOpenChange={next => setOpenSheet(next ? 'hidden-pockets' : null)}
        owner={owner}
        pockets={hidden}
      />
      <MovedSheet
        open={openSheet === 'moved'}
        onDone={() => seenMoved(null)}
        onAccounts={() => seenMoved('accounts')}
      />
    </header>
  );
};
