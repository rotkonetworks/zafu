/**
 * penumbra transaction hook
 *
 * handles building, signing, and broadcasting transactions
 * via the view service
 */

import { useMutation } from '@tanstack/react-query';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { isPenumbraSendRequest, type PenumbraSendRequest } from '../message/penumbra-send';
import { txOpKey, writeTxOp, type TxOp } from '../tx-ops';

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
export const usePenumbraTransaction = () =>
  useMutation({
    mutationFn: (
      input: TransactionPlannerRequest | { planRequest: TransactionPlannerRequest; label: string },
    ): Promise<PenumbraTransactionResult> => {
      const { planRequest, label } =
        input instanceof TransactionPlannerRequest
          ? { planRequest: input, label: undefined }
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
          if (op.status === 'done') {
            finish(() => resolve({ txId: op.txId ?? 'unknown', memo: op.memo }));
          } else if (op.status === 'failed') {
            finish(() => reject(new Error(op.error ?? 'transaction failed')));
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
          finish(() => reject(new Error('invalid send request')));
          return;
        }
        // the record lands before the SW's first write, never racing it
        void recorded
          .then(() => chrome.runtime.sendMessage(request))
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error('failed to reach wallet');
            void writeTxOp(opId, { status: 'failed', error: error.message });
            finish(() => reject(error));
          });
      });
    },
  });
