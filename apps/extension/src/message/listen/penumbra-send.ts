/**
 * Service-worker handler for a Penumbra send. Runs the full plan -> authorize+
 * build -> broadcast sequence on an INTERNAL view client that has no dependency
 * on the requesting page's MessagePort, so the transaction completes even when
 * the side panel reloads (and tears down that port) to show the approval.
 *
 * Progress is written to the transaction tracker (tx-ops, chrome.storage.session)
 * under txOpKey(opId); the page and the home screen read it from there.
 */

import type { Client } from '@connectrpc/connect';
import type { ViewService } from '@penumbra-zone/protobuf';
import { TransactionPlannerRequest } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { bech32mAddress } from '@penumbra-zone/bech32m/penumbra';
import { isValidInternalSender } from '../../senders/internal';
import { isPenumbraSendRequest } from '../penumbra-send';
import { writeTxOp, type TxOp } from '../../tx-ops';

/** A short name for what the plan does, for the transaction tracker. */
const describePlan = (req: TransactionPlannerRequest): string => {
  if (req.delegatorVotes.length) {
    return `vote on #${String(req.delegatorVotes[0]!.proposal)}`;
  }
  if (req.swaps.length) {
    return 'swap';
  }
  if (req.swapClaims.length) {
    return 'claim swap';
  }
  if (req.delegations.length) {
    return 'stake';
  }
  if (req.undelegations.length) {
    return 'unstake';
  }
  if (req.undelegationClaims.length) {
    return 'claim unbonded UM';
  }
  if (req.positionOpens.length) {
    return req.positionOpens.length > 1
      ? `open ${req.positionOpens.length} positions`
      : 'open position';
  }
  if (req.positionCloses.length) {
    return req.positionCloses.length > 1
      ? `close ${req.positionCloses.length} positions`
      : 'close position';
  }
  if (req.positionWithdraws.length) {
    return req.positionWithdraws.length > 1
      ? `withdraw ${req.positionWithdraws.length} positions`
      : 'withdraw position';
  }
  if (req.ics20Withdrawals.length) {
    return 'withdraw out of penumbra';
  }
  if (req.outputs.length) {
    return 'send';
  }
  return 'transaction';
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

async function runSend(
  message: { opId: string; planRequestJson: unknown; label?: string },
  getViewClient: () => Promise<Client<typeof ViewService>>,
): Promise<void> {
  const { opId } = message;

  // resolve recipient + memo up front so every persisted state carries them
  // (each write replaces the whole op record). The home screen uses these to
  // record the sent-message memo once the tx lands.
  let memo: string | undefined;
  let recipient: string | undefined;

  const write = (patch: Partial<TxOp> & Pick<TxOp, 'status'>): Promise<void> =>
    writeTxOp(opId, { network: 'penumbra', memo, recipient, ...patch });

  try {
    const planRequest = TransactionPlannerRequest.fromJson(
      message.planRequestJson as Parameters<typeof TransactionPlannerRequest.fromJson>[0],
    );

    await write({
      status: 'pending',
      step: 'preparing',
      label: message.label ?? describePlan(planRequest),
      startedAt: Date.now(),
    });

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

    await write({ status: 'pending', step: 'planning' });
    const { plan } = await client.transactionPlanner(planRequest);
    if (!plan) {
      throw new Error('failed to create transaction plan');
    }
    // A vote request can plan to zero vote actions (no stake when voting
    // opened); sending that would pay a fee and vote nothing.
    if (
      planRequest.delegatorVotes.length &&
      !plan.actions.some(a => a.action.case === 'delegatorVote')
    ) {
      throw new Error(
        'this account had no staked UM when voting opened, so it has no votes on this proposal',
      );
    }

    // authorize + build. This triggers the approval popup via the custody
    // context - identical machinery to a page-initiated authorizeAndBuild, but
    // driven from a client that survives the panel reload.
    await write({ status: 'pending', step: 'approve and build' });
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
    await write({ status: 'pending', step: 'broadcasting' });
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

    await write({ status: 'done', step: undefined, txId: toHex(txId.inner) });
  } catch (err) {
    await write({
      status: 'failed',
      step: undefined,
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
