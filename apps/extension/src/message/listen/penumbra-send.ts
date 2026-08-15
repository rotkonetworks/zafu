/**
 * Service-worker handler for a Penumbra send. Runs the full plan -> authorize+
 * build -> broadcast sequence on an INTERNAL view client that has no dependency
 * on the requesting page's MessagePort, so the transaction completes even when
 * the side panel reloads (and tears down that port) to show the approval.
 *
 * Progress is written to chrome.storage.session under sendOpKey(opId); the page
 * and the home screen read it from there. See message/penumbra-send.ts.
 */

import type { Client } from '@connectrpc/connect';
import type { ViewService } from '@penumbra-zone/protobuf';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { bech32mAddress } from '@penumbra-zone/bech32m/penumbra';
import { isValidInternalSender } from '../../senders/internal';
import { isPenumbraSendRequest, sendOpKey, type PenumbraSendOp } from '../penumbra-send';

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

async function runSend(
  message: { opId: string; planRequestJson: unknown },
  getViewClient: () => Promise<Client<typeof ViewService>>,
): Promise<void> {
  const { opId } = message;

  // resolve recipient + memo up front so every persisted state carries them
  // (each write replaces the whole op record). The home screen uses these to
  // record the sent-message memo once the tx lands.
  let memo: string | undefined;
  let recipient: string | undefined;

  const write = (patch: Partial<PenumbraSendOp> & Pick<PenumbraSendOp, 'status'>): Promise<void> =>
    chrome.storage.session.set({
      [sendOpKey(opId)]: {
        opId,
        memo,
        recipient,
        updatedAt: Date.now(),
        ...patch,
      } satisfies PenumbraSendOp,
    });

  try {
    const planRequest = TransactionPlannerRequest.fromJson(
      message.planRequestJson as Parameters<typeof TransactionPlannerRequest.fromJson>[0],
    );

    memo = planRequest.memo?.text?.trim() || undefined;
    for (const output of planRequest.outputs ?? []) {
      if (output.address?.altBech32m) {
        recipient = output.address.altBech32m;
        break;
      } else if (output.address) {
        try {
          recipient = bech32mAddress(output.address);
        } catch {
          /* invalid address - leave recipient unset */
        }
      }
    }

    const client = await getViewClient();

    await write({ status: 'planning' });
    const { plan } = await client.transactionPlanner(planRequest);
    if (!plan) {
      throw new Error('failed to create transaction plan');
    }

    // authorize + build. This triggers the approval popup via the custody
    // context - identical machinery to a page-initiated authorizeAndBuild, but
    // driven from a client that survives the panel reload.
    await write({ status: 'building' });
    let transaction;
    for await (const msg of client.authorizeAndBuild({ transactionPlan: plan })) {
      if (msg.status.case === 'complete') {
        transaction = msg.status.value.transaction;
        break;
      }
    }
    if (!transaction) {
      throw new Error('failed to build transaction');
    }

    // Broadcast without awaiting on-chain detection: the money is submitted at
    // broadcastSuccess, and we do not want this SW task blocked on chain
    // scanning. Detection height can be filled in later by the block scanner.
    await write({ status: 'broadcasting' });
    let txId;
    for await (const msg of client.broadcastTransaction({ transaction, awaitDetection: false })) {
      if (msg.status.case === 'broadcastSuccess') {
        txId = msg.status.value.id;
        break;
      }
    }
    if (!txId?.inner) {
      throw new Error('transaction broadcast failed');
    }

    await write({ status: 'success', txId: toHex(txId.inner) });
  } catch (err) {
    await write({
      status: 'error',
      error: err instanceof Error ? err.message : 'transaction failed',
    });
  }
}

/**
 * Build the runtime.onMessage listener. `getViewClient` lazily yields the SW's
 * internal ViewService direct client (created once the rpc handler is ready).
 */
export const createPenumbraSendListener =
  (getViewClient: () => Promise<Client<typeof ViewService>>) =>
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (!isPenumbraSendRequest(message)) {
      return false;
    }
    if (!isValidInternalSender(sender)) {
      return false;
    }
    // Ack synchronously; the real result is delivered through session storage,
    // decoupled from this message's (short-lived) response channel.
    void runSend(message, getViewClient);
    sendResponse({ accepted: true });
    return false;
  };
