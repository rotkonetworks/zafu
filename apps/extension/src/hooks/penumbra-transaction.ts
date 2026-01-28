/**
 * penumbra transaction hook
 *
 * handles building, signing, and broadcasting transactions
 * via the view service
 */

import { useMutation } from '@tanstack/react-query';
import { viewClient } from '../clients';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { useStore } from '../state';
import { messagesSelector } from '../state/messages';
import { bech32mAddress } from '@penumbra-zone/bech32m/penumbra';

/** transaction result */
export interface PenumbraTransactionResult {
  /** transaction id (hash) */
  txId: string;
  /** block height where tx was included */
  blockHeight?: bigint;
  /** memo text if any */
  memo?: string;
}

/** hook for submitting penumbra transactions */
export const usePenumbraTransaction = () => {
  const messages = useStore(messagesSelector);

  return useMutation({
    mutationFn: async (planRequest: TransactionPlannerRequest): Promise<PenumbraTransactionResult> => {
      // extract memo from plan request before sending
      const memoText = planRequest.memo?.text ?? '';
      let recipientAddress = '';

      // get recipient from outputs
      for (const output of planRequest.outputs ?? []) {
        if (output.address?.altBech32m) {
          recipientAddress = output.address.altBech32m;
          break;
        } else if (output.address) {
          try {
            recipientAddress = bech32mAddress(output.address);
          } catch {
            // invalid address
          }
        }
      }

      // 1. create transaction plan
      const planResponse = await viewClient.transactionPlanner(planRequest);
      const plan = planResponse.plan;

      if (!plan) {
        throw new Error('failed to create transaction plan');
      }

      // 2. authorize and build the transaction
      const buildResponse = await viewClient.authorizeAndBuild({ transactionPlan: plan });

      // stream response - get the final built transaction
      let transaction;
      for await (const msg of buildResponse) {
        if (msg.status.case === 'complete') {
          transaction = msg.status.value.transaction;
          break;
        }
      }

      if (!transaction) {
        throw new Error('failed to build transaction');
      }

      // 3. broadcast the transaction
      const broadcastResponse = await viewClient.broadcastTransaction({
        transaction,
        awaitDetection: true,
      });

      // stream response - wait for detection
      let txId;
      let blockHeight;
      for await (const msg of broadcastResponse) {
        if (msg.status.case === 'broadcastSuccess') {
          txId = msg.status.value.id;
        }
        if (msg.status.case === 'confirmed') {
          blockHeight = msg.status.value.detectionHeight;
          break;
        }
      }

      if (!txId) {
        throw new Error('transaction broadcast failed');
      }

      // convert transaction id to hex string
      const txIdHex = txId.inner ? Buffer.from(txId.inner).toString('hex') : 'unknown';

      // save memo to messages if present
      if (memoText.trim()) {
        await messages.addMessage({
          network: 'penumbra',
          recipientAddress,
          content: memoText,
          txId: txIdHex,
          blockHeight: Number(blockHeight ?? 0),
          timestamp: Date.now(),
          direction: 'sent',
          read: true, // sent messages are already read
        });
      }

      return {
        txId: txIdHex,
        blockHeight,
        memo: memoText || undefined,
      };
    },
  });
};
