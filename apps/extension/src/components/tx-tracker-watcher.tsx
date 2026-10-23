/**
 * App-wide watcher for the transaction tracker (tx-ops).
 *
 * Shows one toast when any tracked transaction finishes - on any network,
 * whichever page started it. In side-panel mode the page that started a send
 * is gone by the time it lands (the panel reloaded for the approval), so the
 * outcome must be surfaced from here. Also records the sent-message memo for
 * Penumbra sends (the service worker has no access to the store), and runs
 * the tracker's housekeeping: silent pending ops become `unknown`, announced
 * finished ops are dropped after a while.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../state';
import { messagesSelector } from '../state/messages';
import { queryInjectiveTx } from '@repo/wallet/networks/injective/client';
import {
  awaitingConfirmation,
  claimTxOp,
  forgetForm,
  isTerminal,
  isTxOpShown,
  readTxOps,
  removeTxOps,
  sweep,
  writeTxOp,
  KEEP_FORM_MS,
  type TxOp,
} from '../tx-ops';
import { useTxOps } from '../tx-ops/use-tx-ops';
import { PopupPath } from '../routes/popup/paths';
import type { SendLocationState } from '../routes/popup/send/prefill';

const TOAST_MS = 6_000;
const SWEEP_EVERY_MS = 60_000;
const CONFIRM_EVERY_MS = 6_000;

/** a penumbra send that didn't go through, as its form was: to send it again */
export const againOf = (op: TxOp): SendLocationState | undefined =>
  op.status === 'failed' && op.network === 'penumbra' && op.recipient
    ? {
        network: 'penumbra',
        prefillRecipient: op.recipient,
        prefillMemo: op.memo,
        prefillAmount: op.amount,
        prefillAsset: op.asset,
      }
    : undefined;

export const TxTrackerWatcher = () => {
  const { addMessage } = useStore(messagesSelector);
  const navigate = useNavigate();
  const ops = useTxOps();
  const [toast, setToast] = useState<TxOp | undefined>();
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // announce each finished op once across every open window: the claim has
  // one winner, and a screen still showing its own outcome keeps the toast quiet
  useEffect(() => {
    for (const { opId, status, notified } of ops) {
      if (!isTerminal(status) || notified) {
        continue;
      }
      void claimTxOp(opId).then(async op => {
        if (!op) {
          return;
        }
        if (
          op.status === 'done' &&
          op.network === 'penumbra' &&
          op.memo &&
          op.recipient &&
          op.txId
        ) {
          // the chain cannot recover a sender's memo; this is our only record
          void addMessage({
            network: 'penumbra',
            recipientAddress: op.recipient,
            content: op.memo,
            txId: op.txId,
            blockHeight: 0,
            timestamp: Date.now(),
            direction: 'sent',
            read: true,
          });
        }
        if (await isTxOpShown(opId)) {
          return;
        }
        setToast(op);
        clearTimeout(dismissTimer.current);
        // one that can go again stays as long as its form is kept
        dismissTimer.current = setTimeout(
          () => setToast(undefined),
          againOf(op) ? KEEP_FORM_MS : TOAST_MS,
        );
      });
    }
  }, [ops, addMessage]);

  // confirm mempool-accepted txs from the chain, whichever page sent them
  const confirming = awaitingConfirmation(ops)
    .map(op => op.opId)
    .join(',');
  useEffect(() => {
    if (!confirming) {
      return;
    }
    const check = () =>
      void readTxOps().then(list =>
        Promise.all(
          awaitingConfirmation(list).map(async op => {
            if (!op.restUrl || !op.txId) {
              return;
            }
            try {
              const r = await queryInjectiveTx(op.restUrl, op.txId);
              if (!r.found) {
                return; // not in a block yet
              }
              await writeTxOp(
                op.opId,
                r.code === 0
                  ? { status: 'done', step: undefined }
                  : {
                      status: 'failed',
                      step: undefined,
                      error: r.rawLog || `the chain didn't accept it (code ${r.code})`,
                    },
              );
            } catch {
              // endpoint hiccup: try again next tick
            }
          }),
        ),
      );
    check();
    const id = setInterval(check, CONFIRM_EVERY_MS);
    return () => clearInterval(id);
  }, [confirming]);

  // housekeeping
  useEffect(() => {
    const run = () =>
      void readTxOps()
        .then(async list => {
          const { stale, remove, forget } = sweep(list, Date.now());
          for (const op of stale) {
            await writeTxOp(op.opId, { status: 'unknown' });
          }
          for (const opId of forget) {
            await forgetForm(opId);
          }
          if (remove.length) {
            await removeTxOps(remove);
          }
        })
        .catch(() => undefined);
    run();
    const id = setInterval(run, SWEEP_EVERY_MS);
    return () => {
      clearInterval(id);
      clearTimeout(dismissTimer.current);
    };
  }, []);

  if (!toast) {
    return null;
  }

  const ok = toast.status === 'done';
  const again = againOf(toast);
  const headline =
    toast.status === 'done'
      ? `${toast.label} · sent`
      : toast.status === 'failed'
        ? `${toast.label} · didn't go through`
        : `${toast.label} · no answer yet, please look in activity`;
  return (
    // above the bottom tab bar, never over it
    <div className='pointer-events-none fixed inset-x-0 bottom-[4.5rem] z-[100] flex justify-center px-4'>
      <div
        className={
          'pointer-events-auto flex max-w-sm items-start gap-2 border px-3 py-2 shadow-lg ' +
          (ok
            ? 'border-zigner-gold/40 bg-elev-1 text-fg-high'
            : 'border-hanko/40 bg-elev-1 text-hanko')
        }
      >
        <span
          className={
            (ok ? 'i-ph-check-circle text-zigner-gold' : 'i-ph-warning') +
            ' mt-0.5 h-4 w-4 shrink-0'
          }
        />
        <div className='min-w-0 flex-1'>
          <p className='text-sm'>{headline}</p>
          {!ok && toast.error && (
            <p className='mt-0.5 break-words text-label text-fg-muted'>{toast.error}</p>
          )}
          {again && (
            <button
              type='button'
              onClick={() => {
                setToast(undefined);
                navigate(PopupPath.SEND, { state: again });
              }}
              className='mt-1 text-xs text-zigner-gold hover:underline'
            >
              try again
            </button>
          )}
        </div>
        <button
          type='button'
          onClick={() => setToast(undefined)}
          className='shrink-0 text-fg-muted transition-colors hover:text-fg-high'
          aria-label='dismiss'
        >
          <span className='i-ph-x h-3.5 w-3.5' />
        </button>
      </div>
    </div>
  );
};
