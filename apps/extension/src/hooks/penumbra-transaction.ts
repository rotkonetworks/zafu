/**
 * penumbra transaction hook
 *
 * handles building, signing, and broadcasting transactions
 * via the view service
 */

import { useMutation } from '@tanstack/react-query';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import {
  isPenumbraSendRequest,
  sendOpKey,
  type PenumbraSendOp,
  type PenumbraSendRequest,
} from '../message/penumbra-send';

/** transaction result */
export interface PenumbraTransactionResult {
  /** transaction id (hash) */
  txId: string;
  /** block height where tx was included */
  blockHeight?: bigint;
  /** memo text if any */
  memo?: string;
}

/** if the service worker never answers, give up rather than spin forever */
const SEND_TIMEOUT_MS = 180_000;

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
    mutationFn: (planRequest: TransactionPlannerRequest): Promise<PenumbraTransactionResult> => {
      const opId = crypto.randomUUID();
      const key = sendOpKey(opId);

      return new Promise<PenumbraTransactionResult>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          chrome.storage.session.onChanged.removeListener(onChanged);
          fn();
        };

        const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
          const op = changes[key]?.newValue as PenumbraSendOp | undefined;
          if (!op) {
            return;
          }
          if (op.status === 'success') {
            finish(() =>
              resolve({
                txId: op.txId ?? 'unknown',
                blockHeight: op.blockHeight ? BigInt(op.blockHeight) : undefined,
                memo: op.memo,
              }),
            );
          } else if (op.status === 'error') {
            finish(() => reject(new Error(op.error ?? 'transaction failed')));
          }
        };

        const timer = setTimeout(
          () => finish(() => reject(new Error('send timed out - no response from wallet'))),
          SEND_TIMEOUT_MS,
        );

        // listen before firing, so we cannot miss the first status write
        chrome.storage.session.onChanged.addListener(onChanged);

        const request: PenumbraSendRequest = {
          type: 'PenumbraSend',
          opId,
          planRequestJson: planRequest.toJson(),
        };
        // sanity: request must satisfy its own guard (also keeps the import used)
        if (!isPenumbraSendRequest(request)) {
          finish(() => reject(new Error('invalid send request')));
          return;
        }
        void chrome.runtime.sendMessage(request).catch((err: unknown) => {
          finish(() => reject(err instanceof Error ? err : new Error('failed to reach wallet')));
        });
      });
    },
  });
