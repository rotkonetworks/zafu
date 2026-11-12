/**
 * A thorchain swap out of zec, run on the wallet's own legs
 * (zcash/pay/legs): the swap supplies its labels, its record and the
 * vault's own read; resume picks a swap up where its record stands.
 */

import type { AllSlices } from '..';
import {
  chainTipInWorker,
  lookupTxInWorker,
  planTransparentDepositInWorker,
} from '../keyring/network-worker';
import { selectZcashIsMainnet } from '../wallets';
import { checkVault, type DepositPlan } from '../../workers/transparent-deposit';
import { readVault } from '../../lp/thor';
import { requestEgressOptIn } from '../../net/egress-opt-in';
import { legContextOf, legsFor, payRound, type LegContext } from '../../zcash/pay/legs';
import { patchOpenSwap, type OpenSwap } from './open-swaps';
import { ROUTES } from './routes';
import { isRunning, paymentOf, startThorOut } from './thor-out';

export { legContextOf, type LegContext };
export const swapRound = payRound;

/** the round's line, saying what the device signs */
export const PAIR_LABEL = 'sign once · the move and the swap';
export const PAY_LABEL = 'the swap deposit';

/** run a swap's legs for this wallet; `reviewed` is the plan the person confirmed */
export const runSwapLegs = (swap: OpenSwap, c: LegContext, reviewed?: DepositPlan): void =>
  startThorOut(
    swap,
    legsFor(c, paymentOf(swap), { pair: PAIR_LABEL, pay: PAY_LABEL }),
    {
      // the vault is checked first: nothing moves toward a deposit that could never be paid
      plan: req =>
        checkVault(req.to, req.mainnet).then(() =>
          planTransparentDepositInWorker(c.zidecarUrl, req),
        ),
      save: patch => patchOpenSwap(swap.id, patch),
      mined: async txid => (await lookupTxInWorker(c.zidecarUrl, txid)).height,
      tip: () => chainTipInWorker(c.zidecarUrl),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      now: Date.now,
      // the lp's own check: both operators, read now, must agree
      vault: () => requestEgressOptIn(ROUTES.thor.egress).then(() => readVault()),
    },
    reviewed,
  );

/** a reopened popup picks a swap's legs up where its record stands (the active wallet's only) */
export const resumeSwapLegs = (swap: OpenSwap, s: AllSlices): void => {
  if (swap.stage !== 'thor-out' || !swap.swapT || !swap.depositFee || isRunning(swap.id)) {
    return;
  }
  // thorchain is mainnet; with zcash testnet on, the store and node are testnet's
  if (!selectZcashIsMainnet(s)) {
    return;
  }
  const c = legContextOf(s);
  if (c) {
    runSwapLegs(swap, c);
  }
};
