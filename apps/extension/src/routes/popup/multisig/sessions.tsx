/**
 * multisig tab - FROST threshold wallet management
 *
 * lists multisig wallets with threshold badges and balances.
 * quick actions for create, join, and co-sign flows.
 * status indicators for active DKG/signing sessions.
 */

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../../state';
import {
  selectZcashWallets,
  selectActiveZcashIndex,
  selectMultisigWallets,
  walletsSelector,
  type ZcashWalletJson,
} from '../../../state/wallets';
import { frostDkgSelector, frostSigningSelector } from '../../../state/frost-session';
import { getBalanceInWorker } from '../../../state/keyring/network-worker';
import { cn } from '@repo/ui/lib/utils';
import { PopupPath } from '../paths';

/** format zatoshi to ZEC display string */
const formatZec = (zat: bigint) => {
  const whole = zat / 100_000_000n;
  const frac = zat % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
};

/** truncate address for display */
const truncateAddr = (addr: string) =>
  addr.length > 16 ? `${addr.slice(0, 8)}...${addr.slice(-8)}` : addr;

/** session status indicator */
const SessionBadge = () => {
  const dkg = useStore(frostDkgSelector);
  const signing = useStore(frostSigningSelector);

  if (!dkg && !signing) return null;

  const label = dkg ? `DKG round ${dkg.round}` : `signing - ${signing!.step}`;

  return (
    <div className='flex items-center gap-1.5 rounded-md bg-yellow-500/10 px-2.5 py-1.5 text-xs text-yellow-400'>
      <span className='h-2 w-2 rounded-full bg-yellow-400 animate-pulse' />
      {label}
    </div>
  );
};

/** single wallet row */
const WalletRow = ({
  wallet,
  balance,
  isActive,
  onSelect,
}: {
  wallet: ZcashWalletJson & { originalIndex: number };
  balance: bigint;
  isActive: boolean;
  onSelect: () => void;
}) => (
  <button
    onClick={onSelect}
    className={cn(
      'flex items-center justify-between w-full rounded-lg px-3 py-3 text-left transition-colors',
      isActive ? 'bg-primary/10 ring-1 ring-primary/20' : 'hover:bg-muted/50',
    )}
  >
    <div className='flex flex-col gap-1 min-w-0'>
      <div className='flex items-center gap-2'>
        <span className='rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary leading-none shrink-0'>
          {wallet.multisig!.threshold}-of-{wallet.multisig!.maxSigners}
        </span>
        <span className='text-sm font-medium truncate'>{wallet.label}</span>
        {isActive && (
          <span className='i-lucide-check h-3 w-3 text-primary shrink-0' />
        )}
      </div>
      <span className='text-[11px] text-muted-foreground font-mono'>
        {truncateAddr(wallet.address)}
      </span>
    </div>
    <span className='text-sm font-mono text-muted-foreground shrink-0 ml-2'>
      {formatZec(balance)} ZEC
    </span>
  </button>
);

export const MultisigPage = () => {
  const navigate = useNavigate();
  const zcashWallets = useStore(selectZcashWallets);
  const activeIdx = useStore(selectActiveZcashIndex);
  const multisigWallets = useStore(selectMultisigWallets);
  const { setActiveZcashWallet } = useStore(walletsSelector);
  const [balances, setBalances] = useState<Record<string, bigint>>({});

  const walletsWithIndex = useMemo(
    () => multisigWallets.map(w => ({
      ...w,
      originalIndex: zcashWallets.indexOf(w),
    })),
    [multisigWallets, zcashWallets],
  );

  // fetch balances for all multisig wallets
  useEffect(() => {
    for (const w of walletsWithIndex) {
      getBalanceInWorker('zcash', w.id)
        .then(bal => setBalances(prev => ({ ...prev, [w.id]: BigInt(bal) })))
        .catch(() => {});
    }
  }, [walletsWithIndex]);

  const totalZat = Object.values(balances).reduce((sum, b) => sum + b, 0n);

  return (
    <div className='flex flex-col gap-3 p-4'>
      {/* header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className='i-lucide-shield h-5 w-5 text-primary' />
          <h2 className='text-base font-semibold'>Multisig</h2>
        </div>
        {walletsWithIndex.length > 0 && (
          <span className='text-sm font-mono text-muted-foreground'>
            {formatZec(totalZat)} ZEC
          </span>
        )}
      </div>

      {/* active session indicator */}
      <SessionBadge />

      {/* wallet list */}
      {walletsWithIndex.length > 0 ? (
        <div className='flex flex-col gap-1.5'>
          {walletsWithIndex.map(w => (
            <WalletRow
              key={w.id}
              wallet={w}
              balance={balances[w.id] ?? 0n}
              isActive={w.originalIndex === activeIdx}
              onSelect={() => void setActiveZcashWallet(w.originalIndex)}
            />
          ))}
        </div>
      ) : (
        <div className='flex flex-col items-center gap-2 py-8 text-center text-muted-foreground'>
          <span className='i-lucide-shield-off h-8 w-8 opacity-50' />
          <p className='text-sm'>No multisig wallets yet</p>
        </div>
      )}

      {/* quick actions */}
      <div className='flex flex-col gap-2 pt-2'>
        <div className='flex gap-2'>
          <button
            onClick={() => navigate(PopupPath.MULTISIG_CREATE)}
            className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20'
          >
            <span className='i-lucide-plus h-4 w-4' />
            Create
          </button>
          <button
            onClick={() => navigate(PopupPath.MULTISIG_JOIN)}
            className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/20'
          >
            <span className='i-lucide-user-plus h-4 w-4' />
            Join
          </button>
        </div>
        {walletsWithIndex.length > 0 && (
          <button
            onClick={() => navigate(PopupPath.MULTISIG_SIGN)}
            className='flex items-center justify-center gap-1.5 rounded-lg border border-border/40 px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50'
          >
            <span className='i-lucide-pen-tool h-4 w-4' />
            Co-sign transaction
          </button>
        )}
      </div>
    </div>
  );
};
