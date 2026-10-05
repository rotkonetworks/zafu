/**
 * penumbra transaction hook
 *
 * handles building, signing, and broadcasting transactions
 * via the view service
 */

import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { isPenumbraSendRequest, type PenumbraSendRequest } from '../message/penumbra-send';
import { holdTxOp, txOpKey, writeTxOp, type TxOp } from '../tx-ops';

/** transaction result */
export interface PenumbraTransactionResult {
  /** transaction id (hash) */
  txId: string;
  /** block height where tx was included */
  blockHeight?: bigint;
  /** memo text if any */
  memo?: string;
}

/**
 * hook for submitting penumbra transactions
 *
 * The send runs entirely in the service worker (see message/listen/penumbra-
 * send.ts); we only fire the request and watch session storage for the result.
 * That decoupling is what makes a send survive the side panel reloading to show
 * the approval - the old page-driven flow died with the panel's MessagePort.
 */
export const usePenumbraTransaction = ({
  /** the calling screen shows the outcome itself, so no toast while it is open */
  ownOutcome = true,
}: { ownOutcome?: boolean } = {}) => {
  const holds = useRef(new Set<() => void>());
  useEffect(() => {
    const held = holds.current;
    return () => held.forEach(release => release());
  }, []);
  return useMutation({
    mutationFn: (
      input:
        | TransactionPlannerRequest
        | {
            planRequest: TransactionPlannerRequest;
            label?: string;
            /** each step the service worker reports while the op is pending */
            onStep?: (step: string) => void;
          },
    ): Promise<PenumbraTransactionResult> => {
      const { planRequest, label, onStep } =
        input instanceof TransactionPlannerRequest
          ? { planRequest: input, label: undefined, onStep: undefined }
          : input;
      const opId = crypto.randomUUID();
      const key = txOpKey(opId);

      return new Promise<PenumbraTransactionResult>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          chrome.storage.session.onChanged.removeListener(onChanged);
          fn();
        };

        const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
          const op = changes[key]?.newValue as TxOp | undefined;
          if (!op) {
            return;
          }
          if (op.status === 'pending' && op.step) {
            onStep?.(op.step);
          } else if (op.status === 'done') {
            finish(() => resolve({ txId: op.txId ?? 'unknown', memo: op.memo }));
          } else if (op.status === 'failed') {
            finish(() => reject(new Error(op.error ?? "didn't go through · nothing was sent")));
          } else if (op.status === 'unknown') {
            // no fixed page timeout any more (it fired while people were still
            // approving); the tracker's sweep marks a silent op unknown instead
            finish(() => reject(new Error('no answer from the wallet - check activity')));
          }
        };

        // listen before firing, so we cannot miss the first status write
        chrome.storage.session.onChanged.addListener(onChanged);

        // Write the record ourselves before handing off. If the service worker
        // dies before its first write, there is still a record for the sweep
        // to settle as 'unknown' - otherwise this promise would wait forever
        // (there is deliberately no page-side timeout).
        const recorded = writeTxOp(opId, {
          network: 'penumbra',
          status: 'pending',
          step: 'sending to the wallet',
          ...(label ? { label } : {}),
        });

        const request: PenumbraSendRequest = {
          type: 'PenumbraSend',
          opId,
          planRequestJson: planRequest.toJson(),
          label,
        };
        // sanity: request must satisfy its own guard (also keeps the import used)
        if (!isPenumbraSendRequest(request)) {
          finish(() => reject(new Error("zafu couldn't read this send request")));
          return;
        }
        const shown = ownOutcome
          ? holdTxOp(opId).then(release => void holds.current.add(release))
          : undefined;
        // the record (and the screen's hold) land before the SW's first write
        void Promise.all([recorded, shown])
          .then(() => chrome.runtime.sendMessage(request))
          .catch((err: unknown) => {
            const error =
              err instanceof Error
                ? err
                : new Error("zafu couldn't reach the wallet · please try again");
            void writeTxOp(opId, { status: 'failed', error: error.message });
            finish(() => reject(error));
          });
      });
    },
  });
};
