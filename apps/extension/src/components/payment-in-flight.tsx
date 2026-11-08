/**
 * Payments from a transparent address in flight, on home's in-flight slot:
 * each from its sealed record and its run (zcash/pay). A run that was going
 * when the popup closed is picked up again here; one waiting for the person
 * (an unlock that ran out) carries on with a tap and the password.
 */

import { useEffect, useState } from 'react';
import { useStore as useZustand } from 'zustand';
import { PendingLine } from './in-flight-card';
import { useStore } from '../state';
import { activeZcashStoreId } from '../state/pockets';
import { usePasswordGate } from '../hooks/password-gate';
import { shorten } from '@repo/ui/lib/utils';
import { legContextOf } from '../zcash/pay/legs';
import { openPayments, type OpenPayment } from '../zcash/pay/open-payments';
import { resumePayment, runPayment } from '../zcash/pay/run';
import { openPayUnlock, runs, type Run } from '../zcash/pay/via-fresh';
import { fromUnits } from '../state/swap/provider';
import { onOpenSwapsChange, readOpenSwaps } from '../state/swap/open-swaps';

/** what the card says a run is doing */
const statusOf = (run: Run | undefined): string =>
  !run
    ? 'picking up where it stood'
    : {
        moving: 'unshielding to a fresh address of yours',
        funding: 'waiting for a block',
        paying: 'paying',
        held: 'waiting for you · tap to carry on',
        sent: 'sent',
        expired: 'nothing was moved',
        stopped: 'stopped' + ('error' in run ? ` · ${run.error}` : ''),
      }[run.at];

export const PaymentInFlight = () => {
  const storeId = useStore(activeZcashStoreId);
  const [list, setList] = useState<OpenPayment[]>([]);
  const all = useZustand(runs, r => r);
  const { requestAuth, PasswordModal } = usePasswordGate();
  useEffect(() => {
    const read = () => void openPayments.read().then(setList);
    read();
    return openPayments.onChange(read);
  }, []);
  const mine = list.filter(p => p.wallet === storeId);
  useEffect(() => {
    for (const p of mine) {
      resumePayment(p, useStore.getState());
    }
  }, [mine.map(p => p.id).join()]);

  const carryOn = async (p: OpenPayment) => {
    const ctx = legContextOf(useStore.getState());
    if (!ctx || !(await requestAuth())) {
      return;
    }
    await openPayUnlock(p.id, undefined, ctx.legsPerUnlock);
    runPayment(p, ctx);
  };

  return (
    <>
      {PasswordModal}
      {mine.map(p => {
        const run = all[p.id];
        // nothing moved yet: the person may let it go, and the record with it
        const letGo = run?.at === 'stopped' && !run.moved && !p.moveTxid;
        const held = run?.at === 'held' || run?.at === 'stopped';
        return (
          <PendingLine
            key={p.id}
            tone={run?.at === 'stopped' ? 'danger' : 'gold'}
            icon='i-zafu-enso'
            title={`sending ${fromUnits(BigInt(p.req.amountZat), 8)} to ${shorten(p.req.to, 6, 5)}`}
            status={statusOf(run)}
            action={
              letGo
                ? { label: 'let it go', onClick: () => void openPayments.forget(p.id) }
                : held
                  ? { label: 'carry on', onClick: () => void carryOn(p) }
                  : undefined
            }
          />
        );
      })}
    </>
  );
};

/** the moves of open payments and swaps, which their own cards show */
export const usePaymentMoves = (): ReadonlySet<string> => {
  const [moves, setMoves] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const read = () =>
      void Promise.all([openPayments.read(), readOpenSwaps()]).then(([pays, swaps]) =>
        setMoves(new Set([...pays, ...swaps].map(r => r.moveTxid).filter((t): t is string => !!t))),
      );
    read();
    const offPays = openPayments.onChange(read);
    const offSwaps = onOpenSwapsChange(read);
    return () => {
      offPays();
      offSwaps();
    };
  }, []);
  return moves;
};
