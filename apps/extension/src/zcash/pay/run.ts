/**
 * Run an open payment on this wallet's legs, and pick one up again in a
 * reopened popup. No `check` filter and no expiry: a tex payment has no
 * vault to churn and no price to run out.
 */

import type { AllSlices } from '../../state';
import {
  chainTipInWorker,
  lookupTxInWorker,
  planTransparentDepositInWorker,
} from '../../state/keyring/network-worker';
import { activeZcashStoreId } from '../../state/pockets';
import { selectZcashIsMainnet } from '../../state/wallets';
import type { DepositPlan } from '../../workers/transparent-deposit';
import { legContextOf, legsFor, type LegContext } from './legs';
import { openPayments, type OpenPayment } from './open-payments';
import { isRunning, startViaFresh } from './via-fresh';

/** what the device's round says it signs */
const LABELS = { pair: 'sign once · the move and the payment', pay: 'the payment' };

export const runPayment = (p: OpenPayment, c: LegContext, reviewed?: DepositPlan): void =>
  startViaFresh(
    p,
    legsFor(c, p, LABELS),
    {
      plan: req => planTransparentDepositInWorker(c.zidecarUrl, req),
      save: patch => openPayments.patch(p.id, patch),
      // the payment's own history row takes over once it is out
      done: () => openPayments.forget(p.id),
      mined: async txid => (await lookupTxInWorker(c.zidecarUrl, txid)).height,
      tip: () => chainTipInWorker(c.zidecarUrl),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      now: Date.now,
    },
    reviewed,
  );

/** a reopened popup picks a payment up where its record stands (the active pocket's, on its network) */
export const resumePayment = (p: OpenPayment, s: AllSlices): void => {
  if (
    isRunning(p.id) ||
    p.wallet !== activeZcashStoreId(s) ||
    p.req.mainnet !== selectZcashIsMainnet(s)
  ) {
    return;
  }
  const c = legContextOf(s);
  if (c) {
    runPayment(p, c);
  }
};
