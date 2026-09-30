/**
 * persistent app header - minimal
 * tap the wallet name  -> Accounts sheet (accounts, cold signers, add wallet, lock)
 * tap the network chip -> Network sheet (switch network, turn one on)
 */

import { useState } from 'react';
import { useStore } from '../state';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../state/keyring';
import { selectActiveZcashWallet } from '../state/wallets';
import { getNetwork } from '../config/networks';
import { CustodyBadge } from './custody-badge';
import { AccountsSheet } from './accounts-sheet';
import { NetworkSheet } from './network-sheet';
import { AddWalletSheet } from './add-wallet-sheet';
import { cn } from '@repo/ui/lib/utils';

type OpenSheet = 'accounts' | 'network' | 'add-wallet' | null;

export const AppHeader = () => {
  const activeNetwork = useStore(selectActiveNetwork);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const activeZcashWallet = useStore(selectActiveZcashWallet);
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);

  const networkInfo = getNetwork(activeNetwork);
  // mnemonic vaults derive zcash keys directly - no zcash wallet record
  const walletName =
    activeNetwork === 'zcash' && selectedKeyInfo?.type !== 'mnemonic'
      ? (activeZcashWallet?.label ?? selectedKeyInfo?.name ?? 'no wallet')
      : (selectedKeyInfo?.name ?? 'no wallet');

  return (
    <header className='sticky top-0 z-40 flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border-soft bg-canvas/80 px-3 backdrop-blur-sm'>
      <button
        onClick={() => setOpenSheet('accounts')}
        className='flex min-w-0 items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-elev-1'
        aria-label='accounts'
        aria-haspopup='dialog'
      >
        <span className='max-w-32 truncate text-data text-fg-high lowercase'>{walletName}</span>
        {selectedKeyInfo && <CustodyBadge vault={selectedKeyInfo} showLabel={false} />}
        <span className='i-ph-caret-down h-3 w-3 shrink-0 text-fg-muted' />
      </button>

      <button
        onClick={() => setOpenSheet('network')}
        className='flex shrink-0 items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-elev-1'
        aria-label='switch network'
        aria-haspopup='dialog'
      >
        <span className={cn('h-2.5 w-2.5 rounded-full', networkInfo.color)} />
        <span className='text-data text-fg-high lowercase'>{networkInfo.name}</span>
        {networkInfo.transparent && (
          <span
            className='flex items-center gap-0.5 rounded-md bg-red-500/15 px-1.5 py-0.5 text-label leading-none text-red-500'
            title='transparent network - balances and transactions are PUBLIC, not shielded'
          >
            <span className='i-ph-eye h-3 w-3' />
            unshielded
          </span>
        )}
        <span className='i-ph-caret-down h-3 w-3 text-fg-muted' />
      </button>

      <AccountsSheet
        open={openSheet === 'accounts'}
        onOpenChange={next => setOpenSheet(next ? 'accounts' : null)}
        onAddWallet={() => setOpenSheet('add-wallet')}
      />
      <NetworkSheet
        open={openSheet === 'network'}
        onOpenChange={next => setOpenSheet(next ? 'network' : null)}
      />
      <AddWalletSheet
        open={openSheet === 'add-wallet'}
        onOpenChange={next => setOpenSheet(next ? 'add-wallet' : null)}
      />
    </header>
  );
};
