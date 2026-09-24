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
import { useStore } from '../state';
import { messagesSelector } from '../state/messages';
import { isTerminal, readTxOps, removeTxOps, sweep, writeTxOp, type TxOp } from '../tx-ops';
import { useTxOps } from '../tx-ops/use-tx-ops';

const TOAST_MS = 6_000;
const SWEEP_EVERY_MS = 60_000;

export const TxTrackerWatcher = () => {
  const { addMessage } = useStore(messagesSelector);
  const ops = useTxOps();
  const [toast, setToast] = useState<TxOp | undefined>();
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handled = useRef(new Set<string>());

  // announce each finished op once
  useEffect(() => {
    for (const op of ops) {
      if (!isTerminal(op.status) || op.notified || handled.current.has(op.opId)) {
        continue;
      }
      handled.current.add(op.opId);

      if (op.status === 'done' && op.network === 'penumbra' && op.memo && op.recipient && op.txId) {
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

      setToast(op);
      clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(() => setToast(undefined), TOAST_MS);
      void writeTxOp(op.opId, { status: op.status, notified: true });
    }
  }, [ops, addMessage]);

  // housekeeping
  useEffect(() => {
    const run = () =>
      void readTxOps()
        .then(async list => {
          const { stale, remove } = sweep(list, Date.now());
          for (const op of stale) {
            await writeTxOp(op.opId, { status: 'unknown' });
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
  const headline =
    toast.status === 'done'
      ? `${toast.label} - sent`
      : toast.status === 'failed'
        ? `${toast.label} - failed`
        : `${toast.label} - no answer, check activity`;
  return (
    <div className='pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex justify-center px-4'>
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
          <p className='text-sm font-medium lowercase'>{headline}</p>
          {!ok && toast.error && (
            <p className='mt-0.5 break-words text-label text-fg-muted'>{toast.error}</p>
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
