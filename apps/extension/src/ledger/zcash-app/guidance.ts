/**
 * What the person can do about each Ledger failure. Distinct failures never
 * collapse into one "ledger error" (vizor ledger_failure_guidance.dart).
 *
 * Portions adapted from vizor-wallet (chainapsis/vizor-wallet, Apache-2.0), modified.
 */

import {
  LedgerError,
  MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS,
  type LedgerFailure,
} from './contract';
import { LedgerFlowError, type LedgerFlowFailure } from './operation';

export interface LedgerGuidance {
  /** set when a device failure is the cause */
  readonly failure?: LedgerFailure;
  readonly title: string;
  /** the next step, or what zafu already did */
  readonly action: string;
  /** trying the same request again can succeed */
  readonly retryable: boolean;
}

const DEVICE: Record<LedgerFailure, Omit<LedgerGuidance, 'failure'>> = {
  not_connected: {
    title: 'the ledger is not connected',
    action: 'please plug it in, unlock it and choose it when the browser asks',
    retryable: true,
  },
  locked: {
    title: 'the ledger is locked',
    action: 'please unlock it with its pin, then try again',
    retryable: true,
  },
  app_not_open: {
    title: 'the zcash app is not open',
    action: 'please open the zcash app on the ledger, then try again',
    retryable: true,
  },
  app_too_old: {
    title: 'the zcash app needs an update',
    action: `please update it to ${MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS} or newer in ledger live, then reconnect`,
    retryable: true,
  },
  rejected: {
    title: 'declined on the ledger',
    action: 'nothing was sent. when you are ready, try again and approve it on the device',
    retryable: true,
  },
  busy: {
    title: 'the ledger is busy',
    action: 'another request is still open on it. please finish or decline it there first',
    retryable: true,
  },
  unsupported_transaction: {
    title: 'the ledger app cannot sign this',
    action: 'nothing reached the device. a send with fewer inputs or outputs may work',
    retryable: false,
  },
  change_to_other_account: {
    title: 'the ledger did not recognise the change',
    action: "it says the change is not this account's. please send again from this wallet",
    retryable: false,
  },
  cancelled: {
    title: 'stopped',
    action: 'nothing was sent. if the ledger still shows the request, please decline it there',
    retryable: true,
  },
  protocol_error: {
    title: 'the ledger answered in a way we did not expect',
    action: 'please keep one ledger connected with the zcash app open, and try again',
    retryable: true,
  },
};

const FLOW: Record<LedgerFlowFailure, Omit<LedgerGuidance, 'action'>> = {
  context_changed: { title: 'the account or network changed', retryable: false },
  checkpoint_failed: { title: 'signed, not saved yet', retryable: true },
  broadcast_rejected: { title: 'the network declined the transaction', retryable: false },
  unresolved_operation: {
    title: 'an earlier ledger transaction is still settling',
    retryable: false,
  },
  busy: { title: 'already being sent', retryable: true },
  not_retryable: { title: 'this transaction cannot be sent again', retryable: false },
  funds_unreadable: { title: 'zafu could not read your funds', retryable: true },
};

const device = (failure: LedgerFailure): LedgerGuidance => ({ failure, ...DEVICE[failure] });

/** guidance for anything a Ledger flow threw */
export function ledgerGuidance(e: unknown): LedgerGuidance {
  if (e instanceof LedgerError) {
    return device(e.failure);
  }
  if (e instanceof LedgerFlowError) {
    return { ...FLOW[e.code], action: e.message };
  }
  // a WebHID DOMException (the picker dismissed, access refused) is not an Error everywhere
  const { name, message } = (typeof e === 'object' && e !== null ? e : {}) as {
    name?: unknown;
    message?: unknown;
  };
  const text = typeof message === 'string' ? message : String(e);
  if (name === 'NotFoundError' || name === 'NotAllowedError' || /\bhid\b|no device/i.test(text)) {
    return device('not_connected');
  }
  if (name === 'AbortError') {
    return device('cancelled');
  }
  return { title: 'something broke on our side, not yours', action: text, retryable: true };
}
