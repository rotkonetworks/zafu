/**
 * persistent app header - minimal
 * tap the wallet name  -> Accounts sheet (accounts, cold signers, add wallet, lock)
 * tap the network chip -> Network sheet (switch network, turn one on)
 */

import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { activeAccountIndex, activePockets } from '../state/pockets';
import { getNetwork } from '../config/networks';
import { CustodyBadge } from './custody-badge';
import { AccountsSheet, type PocketSheetTarget } from './accounts-sheet';
import { NetworkSheet } from './network-sheet';
import { AddWalletSheet } from './add-wallet-sheet';
import { NewPocketSheet } from './new-pocket-sheet';
import { cn } from '@repo/ui/lib/utils';
import { Mark } from '@repo/ui/components/ui/mark';

type OpenSheet = 'accounts' | 'network' | 'add-wallet' | 'new-pocket' | null;

export const AppHeader = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const pockets = useStore(useShallow(activePockets));
  const pocketAccount = useStore(activeAccountIndex);
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);
  // set when the new-pocket sheet is opened to rename an existing pocket
  // instead of creating one
  const [renameTarget, setRenameTarget] = useState<PocketSheetTarget>();

  const networkInfo = getNetwork(activeNetwork);
  // mnemonic vaults derive zcash keys directly - no zcash wallet record
  const walletName =
    activeNetwork === 'zcash' && selectedKeyInfo?.type !== 'mnemonic'
      ? (activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'no wallet')
      : (selectedKeyInfo?.name ?? 'no wallet');
  // pockets exist only for the hot wallet - shows which one is active
  const pocketName = pockets.find(p => p.account === pocketAccount)?.name;

  return (
    <header className='sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border-soft bg-canvas pl-3 pr-2'>
      <button
        onClick={() => setOpenSheet('accounts')}
        className='flex h-10 min-w-0 items-center gap-2.5 pl-1 pr-2.5 transition-colors hover:bg-elev-2'
        aria-label='accounts'
        aria-haspopup='dialog'
      >
        <Mark variant='seal' size={26} />
        <span className='flex min-w-0 flex-col items-start leading-tight'>
          <span className='max-w-32 truncate text-sm text-fg-high lowercase'>{walletName}</span>
          {pocketName && (
            <span className='max-w-32 truncate text-[11px] text-fg-muted lowercase'>
              {pocketName}
            </span>
          )}
        </span>
        {selectedKeyInfo && <CustodyBadge vault={selectedKeyInfo} showLabel={false} />}
        <span className='i-lucide-chevron-down size-3.5 shrink-0 text-fg-muted' />
      </button>

      <button
        onClick={() => setOpenSheet('network')}
        className='flex h-8 shrink-0 items-center gap-2 border border-border-soft bg-elev-1 px-2.5 transition-colors hover:bg-elev-2'
        aria-label='switch network'
        aria-haspopup='dialog'
      >
        <span className={cn('size-2', networkInfo.color)} />
        <span className='text-[13px] text-fg-high lowercase'>{networkInfo.name}</span>
        {networkInfo.transparent && (
          <span
            className='flex items-center gap-0.5 bg-hanko/15 px-1.5 py-0.5 text-label leading-none text-hanko'
            title='transparent network - balances and transactions are PUBLIC, not shielded'
          >
            <span className='i-ph-eye h-3 w-3' />
            unshielded
          </span>
        )}
        <span className='i-lucide-chevron-down size-3 text-fg-muted' />
      </button>

      <AccountsSheet
        open={openSheet === 'accounts'}
        onOpenChange={next => setOpenSheet(next ? 'accounts' : null)}
        onAddWallet={() => setOpenSheet('add-wallet')}
        onNewPocket={rename => {
          setRenameTarget(rename);
          setOpenSheet('new-pocket');
        }}
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
    </header>
  );
};
