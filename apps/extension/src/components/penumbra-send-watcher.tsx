/**
 * App-wide watcher for service-worker-driven Penumbra sends.
 *
 * A send now runs in the service worker and reports through session storage
 * (see message/penumbra-send.ts). In popup-window mode the send page is still
 * alive and shows its own success UI - but in side-panel mode that page was
 * destroyed when the panel reloaded for the approval, and the panel comes back
 * to a FRESH home document. This watcher, mounted app-wide, is what lets that
 * restored home surface the outcome and record the sent-message memo.
 *
 * It processes a terminal op exactly once by removing its storage key after
 * handling; addMessage dedups by txId, so a double-sighting is harmless.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state';
import { messagesSelector } from '../state/messages';
import {
  PENUMBRA_SEND_OP_PREFIX,
  isTerminalStatus,
  sendOpKey,
  type PenumbraSendOp,
} from '../message/penumbra-send';

interface Toast {
  status: 'success' | 'error';
  txId?: string;
  error?: string;
}

const TOAST_MS = 6_000;

export const PenumbraSendWatcher = () => {
  const { addMessage } = useStore(messagesSelector);
  const [toast, setToast] = useState<Toast | undefined>();
  const handled = useRef(new Set<string>());
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const showToast = (t: Toast) => {
      setToast(t);
      clearTimeout(dismissTimer.current);
      dismissTimer.current = setTimeout(() => setToast(undefined), TOAST_MS);
    };

    const process = (op: PenumbraSendOp) => {
      if (!isTerminalStatus(op.status) || handled.current.has(op.opId)) {
        return;
      }
      handled.current.add(op.opId);

      if (op.status === 'success') {
        // record the sent-message memo (the SW has no access to the store); the
        // chain cannot recover a sender's memo, so this is our only record.
        if (op.memo && op.recipient && op.txId) {
          void addMessage({
            network: 'penumbra',
            recipientAddress: op.recipient,
            content: op.memo,
            txId: op.txId,
            blockHeight: op.blockHeight ?? 0,
            timestamp: Date.now(),
            direction: 'sent',
            read: true,
          });
        }
        showToast({ status: 'success', txId: op.txId });
      } else {
        showToast({ status: 'error', error: op.error });
      }

      // processed - drop the key so it is handled once and does not linger
      void chrome.storage.session.remove(sendOpKey(op.opId));
    };

    // catch ops that already reached a terminal state before this document
    // mounted (the side-panel-restore case, where onChanged fired earlier)
    void chrome.storage.session.get(null).then(all => {
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(PENUMBRA_SEND_OP_PREFIX) && value) {
          process(value as PenumbraSendOp);
        }
      }
    });

    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith(PENUMBRA_SEND_OP_PREFIX) && change.newValue) {
          process(change.newValue as PenumbraSendOp);
        }
      }
    };
    chrome.storage.session.onChanged.addListener(onChanged);

    return () => {
      chrome.storage.session.onChanged.removeListener(onChanged);
      clearTimeout(dismissTimer.current);
    };
  }, [addMessage]);

  if (!toast) {
    return null;
  }

  const ok = toast.status === 'success';
  return (
    <div className='pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex justify-center px-4'>
      <div
        className={
          'pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 shadow-lg ' +
          (ok
            ? 'border-green-500/40 bg-green-500/10 text-green-400'
            : 'border-hanko/40 bg-elev-1 text-hanko')
        }
      >
        <span
          className={(ok ? 'i-ph-check-circle' : 'i-ph-warning') + ' mt-0.5 h-4 w-4 shrink-0'}
        />
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-medium lowercase'>
            {ok ? 'transaction sent' : 'transaction failed'}
          </p>
          {ok && toast.txId ? (
            <p className='mt-0.5 truncate font-mono text-label text-fg-muted'>
              {toast.txId.slice(0, 16)}...
            </p>
          ) : (
            !ok &&
            toast.error && (
              <p className='mt-0.5 break-words text-label text-fg-muted'>{toast.error}</p>
            )
          )}
        </div>
        <button
          type='button'
          onClick={() => setToast(undefined)}
          className='shrink-0 text-fg-muted transition-colors hover:text-fg-high'
          title='dismiss'
        >
          <span className='i-ph-x h-3.5 w-3.5' />
        </button>
      </div>
    </div>
  );
};
