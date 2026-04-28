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
  selectMultisigWallets,
  walletsSelector,
  type ZcashWalletJson,
} from '../../../state/wallets';
import { selectActiveNetwork, selectEffectiveKeyInfo } from '../../../state/keyring';
import { frostDkgSelector, frostSigningSelector } from '../../../state/frost-session';
import { getBalanceInWorker } from '../../../state/keyring/network-worker';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { NetworkUnavailable } from '../../../shared/components/network-unavailable';
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
  onEdit,
}: {
  wallet: ZcashWalletJson & { originalIndex: number };
  balance: bigint;
  isActive: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) => (
  <div
    className={cn(
      'flex items-center w-full rounded-lg px-3 py-3 transition-colors',
      isActive ? 'bg-primary/10 ring-1 ring-primary/20' : 'hover:bg-elev-1',
    )}
  >
    <button onClick={onSelect} className='flex flex-1 items-center justify-between min-w-0 text-left'>
      <div className='flex flex-col gap-1 min-w-0'>
        <div className='flex items-center gap-2'>
          <span className='rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-zigner-gold leading-none shrink-0'>
            {wallet.multisig!.threshold}-of-{wallet.multisig!.maxSigners}
          </span>
          <span className='text-sm font-medium truncate'>{wallet.label}</span>
          {isActive && (
            <span className='i-lucide-check h-3 w-3 text-zigner-gold shrink-0' />
          )}
        </div>
        <span className='text-[11px] text-fg-muted font-mono'>
          {truncateAddr(wallet.address)}
        </span>
      </div>
      <span className='text-sm font-mono text-fg-muted shrink-0 ml-2'>
        {formatZec(balance)} ZEC
      </span>
    </button>
    <button
      onClick={onEdit}
      className='ml-2 p-1.5 rounded-md text-fg-muted hover:text-fg-high hover:bg-elev-1 transition-colors shrink-0'
      title='wallet settings'
    >
      <span className='i-lucide-settings h-3.5 w-3.5' />
    </button>
  </div>
);

export const MultisigPage = () => {
  const navigate = useNavigate();
  const activeNetwork = useStore(selectActiveNetwork);
  const zcashWallets = useStore(selectZcashWallets);
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const multisigWallets = useStore(selectMultisigWallets);
  const { setActiveZcashWallet } = useStore(walletsSelector);
  const { workerSyncHeight } = useZcashSyncStatus();
  const [balances, setBalances] = useState<Record<string, bigint>>({});

  // multisig is zcash-only; placeholder elsewhere. Computed early but
  // applied as an early-return only after every hook below has run, so
  // the hook count stays stable across network switches.
  const isZcash = activeNetwork === 'zcash';

  const walletsWithIndex = useMemo(
    () => multisigWallets.map(w => ({
      ...w,
      originalIndex: zcashWallets.indexOf(w),
    })),
    [multisigWallets, zcashWallets],
  );

  // fetch balances for all multisig wallets. sync writes notes keyed by
  // vaultId (selectedKeyInfo.id), not zcashWallet.id, so the balance lookup
  // must use vaultId; local state stays keyed by w.id for row identity.
  // re-fetch on every sync-progress tick so the active vault's row stays
  // in step with the home-page balance. skip entirely when off zcash —
  // gate inside the effect, not around it (Rules of Hooks).
  useEffect(() => {
    if (!isZcash) return;
    const fetchAll = () => {
      for (const w of walletsWithIndex) {
        if (!w.vaultId) continue;
        const vaultId = w.vaultId;
        const rowId = w.id;
        getBalanceInWorker('zcash', vaultId)
          .then(bal => setBalances(prev => ({ ...prev, [rowId]: BigInt(bal) })))
          .catch(() => {});
      }
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') return;
      fetchAll();
    };
    window.addEventListener('network-sync-progress', handler);
    fetchAll();
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [walletsWithIndex, workerSyncHeight, isZcash]);

  const totalZat = Object.values(balances).reduce((sum, b) => sum + b, 0n);

  // operate-mode: gate on the selected vault, not activeZcashIndex — the
  // index lags on switches to mnemonic (which has no zcash wallet record),
  // so the index can still point at a multisig vault while the user is on
  // a mnemonic. selectedKeyInfo.type is the source of truth.
  const activeMs = selectedKeyInfo?.type === 'frost-multisig'
    ? walletsWithIndex.find(w => w.vaultId === selectedKeyInfo.id)
    : undefined;

  if (!isZcash) {
    return <NetworkUnavailable feature='multisig' iconClass='i-lucide-shield' />;
  }

  return (
    <div className='flex flex-col gap-3 p-4'>
      {/* header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className='i-lucide-shield h-5 w-5 text-zigner-gold' />
          <h2 className='text-base font-semibold'>Multisig</h2>
        </div>
        {walletsWithIndex.length > 0 && (
          <span className='text-sm font-mono text-fg-muted'>
            {formatZec(totalZat)} ZEC
          </span>
        )}
      </div>

      {/* active session indicator */}
      <SessionBadge />

      {activeMs ? (
        // operate mode — active vault is multisig
        <>
          {/* primary CTA: co-sign */}
          <button
            onClick={() => navigate(PopupPath.MULTISIG_SIGN)}
            className='flex items-center justify-center gap-2 rounded-lg bg-primary/15 px-4 py-4 text-base font-semibold text-zigner-gold transition-colors hover:bg-primary/25'
          >
            <span className='i-lucide-pen-tool h-5 w-5' />
            Co-sign transaction
          </button>

          {/* active vault card */}
          <WalletRow
            key={activeMs.id}
            wallet={activeMs}
            balance={balances[activeMs.id] ?? 0n}
            isActive
            onSelect={() => {}}
            onEdit={() => navigate(`${PopupPath.SETTINGS_MULTISIG}?id=${activeMs.id}`)}
          />

          {/* secondary actions: small icon-buttons in a footer */}
          <div className='flex items-center justify-center gap-4 pt-1'>
            <button
              onClick={() => navigate(PopupPath.MULTISIG_CREATE)}
              className='flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-zigner-gold'
            >
              <span className='i-lucide-plus h-3.5 w-3.5' />
              New vault
            </button>
            <span className='h-3 w-px bg-border-soft' />
            <button
              onClick={() => navigate(PopupPath.MULTISIG_JOIN)}
              className='flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-zigner-gold'
            >
              <span className='i-lucide-user-plus h-3.5 w-3.5' />
              Join existing
            </button>
          </div>
        </>
      ) : (
        // overview mode — active wallet is not multisig (or none exist)
        <>
          {walletsWithIndex.length > 0 ? (
            <div className='flex flex-col gap-1.5'>
              {walletsWithIndex.map(w => (
                <WalletRow
                  key={w.id}
                  wallet={w}
                  balance={balances[w.id] ?? 0n}
                  isActive={w.vaultId === selectedKeyInfo?.id}
                  onSelect={() => void setActiveZcashWallet(w.originalIndex)}
                  onEdit={() => navigate(`${PopupPath.SETTINGS_MULTISIG}?id=${w.id}`)}
                />
              ))}
            </div>
          ) : (
            <div className='flex flex-col items-center gap-2 py-8 text-center text-fg-muted'>
              <span className='i-lucide-shield-off h-8 w-8 opacity-50' />
              <p className='text-sm'>No multisig wallets yet</p>
            </div>
          )}

          <div className='flex flex-col gap-2 pt-2'>
            <div className='flex gap-2'>
              <button
                onClick={() => navigate(PopupPath.MULTISIG_CREATE)}
                className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2.5 text-sm font-medium text-zigner-gold transition-colors hover:bg-primary/20'
              >
                <span className='i-lucide-plus h-4 w-4' />
                Create
              </button>
              <button
                onClick={() => navigate(PopupPath.MULTISIG_JOIN)}
                className='flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2.5 text-sm font-medium text-zigner-gold transition-colors hover:bg-primary/20'
              >
                <span className='i-lucide-user-plus h-4 w-4' />
                Join
              </button>
            </div>
            {walletsWithIndex.length > 0 && (
              <button
                onClick={() => navigate(PopupPath.MULTISIG_SIGN)}
                className='flex items-center justify-center gap-1.5 rounded-lg border border-border-soft px-3 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-elev-1'
              >
                <span className='i-lucide-pen-tool h-4 w-4' />
                Co-sign transaction
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};
