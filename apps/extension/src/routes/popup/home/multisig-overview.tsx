import { useState, useMemo, useEffect } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { useStore } from '../../../state';
import { Sensitive } from '../../../components/sensitive';
import { selectSelectKeyRing } from '../../../state/keyring';
import { selectZcashWallets, selectActiveZcashIndex } from '../../../state/wallets';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { getBalanceInWorker } from '../../../state/keyring/network-worker';

/** shows all multisig wallets with balances at a glance */
export const MultisigOverview = () => {
  const zcashWallets = useStore(selectZcashWallets);
  const activeIdx = useStore(selectActiveZcashIndex);
  const selectKeyRing = useStore(selectSelectKeyRing);
  const { workerSyncHeight } = useZcashSyncStatus();
  const [expanded, setExpanded] = useState(false);
  const [balances, setBalances] = useState<Record<string, bigint>>({});

  const multisigWallets = useMemo(
    () =>
      zcashWallets
        .filter(w => w.multisig && !w.multisig.hidden)
        .map(w => ({ ...w, originalIndex: zcashWallets.indexOf(w) })),
    [zcashWallets],
  );

  // fetch balances for all multisig wallets. sync writes notes keyed by
  // vaultId (selectedKeyInfo.id), not zcashWallet.id, so the balance lookup
  // must use vaultId; local state stays keyed by w.id for row identity.
  // re-fetch on every sync-progress tick — only the *active* wallet emits
  // these, but that's enough to refresh the active multisig vault's row.
  useEffect(() => {
    const fetchAll = () => {
      for (const w of multisigWallets) {
        if (!w.vaultId) {
          continue;
        }
        const vaultId = w.vaultId;
        const rowId = w.id;
        getBalanceInWorker('zcash', vaultId)
          .then(bal => setBalances(prev => ({ ...prev, [rowId]: BigInt(bal) })))
          .catch(() => {});
      }
    };
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.network !== 'zcash') {
        return;
      }
      fetchAll();
    };
    window.addEventListener('network-sync-progress', handler);
    fetchAll();
    return () => window.removeEventListener('network-sync-progress', handler);
  }, [multisigWallets, workerSyncHeight]);

  if (multisigWallets.length === 0) {
    return null;
  }

  const totalZat = Object.values(balances).reduce((sum, b) => sum + b, 0n);
  const formatZec = (zat: bigint) => {
    const whole = zat / 100_000_000n;
    const frac = zat % 100_000_000n;
    const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '') || '0';
    return `${whole}.${fracStr}`;
  };

  return (
    <div className='rounded-md border border-border-soft bg-elev-1'>
      <button
        onClick={() => setExpanded(!expanded)}
        className='flex items-center justify-between w-full px-4 py-3 text-left'
      >
        <div className='flex items-center gap-2'>
          <span className='i-ph-key h-4 w-4 text-zigner-gold' />
          <span className='text-data text-fg-high lowercase'>multisig wallets</span>
          <span className='rounded-full bg-zigner-gold/15 px-1.5 py-0.5 text-label text-zigner-gold tabular'>
            {multisigWallets.length}
          </span>
        </div>
        <div className='flex items-center gap-2'>
          <Sensitive className='text-data tabular text-fg-muted'>
            {formatZec(totalZat)} ZEC
          </Sensitive>
          <span
            className={cn(
              'h-4 w-4 text-fg-dim transition-transform',
              expanded ? 'i-ph-caret-up' : 'i-ph-caret-down',
            )}
          />
        </div>
      </button>

      {expanded && (
        <div className='border-t border-border-soft px-4 py-2 space-y-1'>
          {multisigWallets.map(w => {
            const bal = balances[w.id] ?? 0n;
            const isActive = w.originalIndex === activeIdx;
            return (
              <button
                key={w.id}
                onClick={() => {
                  void selectKeyRing(w.vaultId);
                }}
                className={cn(
                  'flex items-center justify-between w-full rounded-sm px-3 py-2 text-left transition-colors',
                  isActive ? 'bg-zigner-gold/10' : 'hover:bg-elev-2',
                )}
              >
                <div className='flex items-center gap-2 min-w-0'>
                  <span className='rounded-sm bg-zigner-gold/15 px-1.5 py-0.5 text-label text-zigner-gold tabular leading-none shrink-0'>
                    {w.multisig!.threshold}/{w.multisig!.maxSigners}
                  </span>
                  <span className='text-data text-fg-high truncate'>{w.label}</span>
                  {isActive && <span className='i-ph-check h-3 w-3 text-zigner-gold shrink-0' />}
                </div>
                <Sensitive className='text-data tabular text-fg-muted shrink-0'>
                  {formatZec(bal)}
                </Sensitive>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

