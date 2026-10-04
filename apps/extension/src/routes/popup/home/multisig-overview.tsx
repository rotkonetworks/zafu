import { useState, useMemo, useEffect } from 'react';
import { cn } from '@repo/ui/lib/utils';
import { Row, RowGroup } from '@repo/ui/components/ui/row';
import { Sheet } from '@repo/ui/components/ui/sheet';
import { useStore } from '../../../state';
import { privacySelector } from '../../../state/privacy';
import { selectSelectKeyRing } from '../../../state/keyring';
import { selectZcashWallets, selectActiveZcashIndex } from '../../../state/wallets';
import { useZcashSyncStatus } from '../../../hooks/zcash-sync';
import { getBalanceInWorker } from '../../../state/keyring/network-worker';

const formatZec = (zat: bigint) => {
  const whole = zat / 100_000_000n;
  const frac = zat % 100_000_000n;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
};

/** shows all multisig wallets with balances at a glance, opened as a Sheet -
 *  nothing on the home screen expands in place. */
export const MultisigOverview = () => {
  const zcashWallets = useStore(selectZcashWallets);
  const activeIdx = useStore(selectActiveZcashIndex);
  const selectKeyRing = useStore(selectSelectKeyRing);
  const { settings: privacySettings } = useStore(privacySelector);
  const { workerSyncHeight } = useZcashSyncStatus();
  const [open, setOpen] = useState(false);
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
  // re-fetch on every sync-progress tick - only the *active* wallet emits
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
  // Row's value is a plain string - mask it the same way Sensitive does
  // elsewhere when hide-balances is on, rather than silently losing coverage.
  const maskOr = (zat: bigint) =>
    privacySettings.hideBalances ? '•••••' : `${formatZec(zat)} ZEC`;

  return (
    <>
      <RowGroup>
        <Row
          type='value'
          icon='i-ph-key'
          label='multisig wallets'
          description={`${multisigWallets.length}`}
          value={maskOr(totalZat)}
          onPress={() => setOpen(true)}
        />
      </RowGroup>
      <Sheet open={open} onOpenChange={setOpen} title='multisig wallets'>
        <RowGroup>
          {multisigWallets.map(w => {
            const bal = balances[w.id] ?? 0n;
            const isActive = w.originalIndex === activeIdx;
            return (
              <Row
                key={w.id}
                type='value'
                label={w.label}
                description={`${w.multisig!.threshold}/${w.multisig!.maxSigners}`}
                value={maskOr(bal)}
                className={cn(isActive && 'bg-zigner-gold/10')}
                onPress={() => {
                  setOpen(false);
                  void selectKeyRing(w.vaultId);
                }}
              />
            );
          })}
        </RowGroup>
      </Sheet>
    </>
  );
};
