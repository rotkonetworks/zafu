/**
 * The two legs of a thorchain swap out of zec, per wallet kind: a hot wallet
 * signs in the worker under the swap's one unlock, a zigner wallet in one qr
 * round for both (signing/move-and-deposit): the move goes at once, the
 * deposit is held until the move is mined. The run that drives
 * them is ./thor-out; this is where the kind is chosen, once.
 */

import type { AllSlices } from '..';
import { selectEffectiveKeyInfo } from '../keyring';
import { selectTxSigningSecurity } from '../privacy';
import {
  applySignatureContributionsInWorker,
  broadcastSignedTxInWorker,
  buildColdDepositInWorker,
  buildSendTxInWorker,
  buildSendTxPcztInWorker,
  chainTipInWorker,
  completeColdDepositInWorker,
  extractSignedPcztTxInWorker,
  frostInspectPcztOutputsInWorker,
  holdColdDepositInWorker,
  lookupTxInWorker,
  planTransparentDepositInWorker,
  sendTransparentDepositInWorker,
  type SignatureContribution,
} from '../keyring/network-worker';
import type { VaultUnlock } from '../keyring/types';
import { activeAccountIndex, activeZcashStoreId } from '../pockets';
import { selectActiveZcashWallet } from '../wallets';
import { walletKind } from '../../signing/wallet-kind';
import { moveAndDeposit } from '../../signing/move-and-deposit';
import { createZignerRound, type ZignerRound } from '../../signing/zigner-round';
import {
  checkVault,
  type DepositPlan,
  type MoveInspected,
} from '../../workers/transparent-deposit';
import { readVault } from '../../lp/thor';
import { requestEgressOptIn } from '../../net/egress-opt-in';
import { patchOpenSwap, type OpenSwap } from './open-swaps';
import { ROUTES } from './routes';
import {
  depositOf,
  isRunning,
  legsPerUnlock,
  startThorOut,
  takeSwapUnlock,
  type Legs,
} from './thor-out';

/** what signing a swap's legs needs from the wallet, read once from the store */
export interface LegContext {
  storeId: string;
  walletId: string;
  pocket: number;
  zidecarUrl: string;
  /** set for a zigner wallet: it builds what the device signs */
  ufvk?: string;
  cold: boolean;
  /** how many legs one password signs (one at foilhat) */
  legsPerUnlock: number;
  getVaultUnlock: (walletId: string) => Promise<VaultUnlock>;
}

export const legContextOf = (s: AllSlices): LegContext | undefined => {
  const key = selectEffectiveKeyInfo(s);
  const zw = selectActiveZcashWallet(s);
  if (!key) {
    return undefined;
  }
  return {
    storeId: activeZcashStoreId(s) ?? key.id,
    walletId: key.id,
    pocket: activeAccountIndex(s),
    zidecarUrl: s.networks.networks.zcash.endpoint || 'https://zcash.rotko.net',
    ufvk: zw?.ufvk ?? (zw?.orchardFvk?.startsWith('uview') ? zw.orchardFvk : undefined),
    cold: walletKind(key, zw) === 'zigner',
    legsPerUnlock: legsPerUnlock(selectTxSigningSecurity(s)),
    getVaultUnlock: s.keyRing.getVaultUnlock,
  };
};

const hotLegs = (c: LegContext, swap: OpenSwap): Legs => ({
  ready: () => takeSwapUnlock(swap.id),
  move: async short => {
    const sent = await buildSendTxInWorker(
      'zcash',
      c.storeId,
      c.zidecarUrl,
      swap.swapT!.address,
      short,
      '',
      c.pocket,
      true,
      await c.getVaultUnlock(c.walletId),
    );
    if (!('txid' in sent)) {
      throw new Error(
        "the move didn't reach the network · please look at home before trying again",
      );
    }
    return sent.txid;
  },
  pay: async req =>
    (
      await sendTransparentDepositInWorker(
        c.storeId,
        c.zidecarUrl,
        req,
        await c.getVaultUnlock(c.walletId),
      )
    ).txid,
});

/** each swap's device round, kept while its run lives so the tracker shows it */
const rounds = new Map<string, ZignerRound>();

export const swapRound = (id: string, storeId: string): ZignerRound => {
  let round = rounds.get(id);
  if (!round) {
    round = createZignerRound((pczt, json) =>
      applySignatureContributionsInWorker(
        'zcash',
        storeId,
        pczt,
        JSON.parse(json) as SignatureContribution[],
      ),
    );
    rounds.set(id, round);
  }
  return round;
};

/** the round's line, saying what the device signs */
export const PAIR_LABEL = 'sign once · the move and the swap';
export const PAY_LABEL = 'the swap deposit';

const coldLegs = (c: LegContext, swap: OpenSwap): Legs => {
  const round = swapRound(swap.id, c.storeId);
  const ufvk = () => {
    if (!c.ufvk) {
      throw new Error('this zigner wallet has no viewing key here · please re-import it');
    }
    return c.ufvk;
  };
  const req = depositOf(swap);
  return {
    // the device is the confirmation: each round is approved there
    ready: () => Promise.resolve(true),
    move: (short, hold) => {
      const key = ufvk();
      return moveAndDeposit(
        {
          buildMove: () =>
            buildSendTxPcztInWorker(
              'zcash',
              c.storeId,
              c.zidecarUrl,
              req.tAddress,
              short,
              '',
              0,
              true,
              key,
              false,
              undefined,
              undefined,
              true,
            ),
          inspect: async pczt =>
            (await frostInspectPcztOutputsInWorker(pczt, key)) as unknown as MoveInspected,
          buildDeposit: (coin, movePcztHex) =>
            buildColdDepositInWorker(c.storeId, c.zidecarUrl, req, key, {
              coin,
              movePcztHex,
            }),
          sign: ask => round.signBatch(ask, 2, PAIR_LABEL),
          finishDeposit: (unsignedPcztHex, signedPcztHex) =>
            holdColdDepositInWorker(c.storeId, c.zidecarUrl, req, key, {
              unsignedPcztHex,
              signedPcztHex,
            }),
          extract: extractSignedPcztTxInWorker,
          hold,
          broadcastMove: async (txHex, coldSendId) =>
            (await broadcastSignedTxInWorker(c.storeId, c.zidecarUrl, txHex, coldSendId)).txid,
        },
        req.tAddress,
        short,
      );
    },
    pay: async (r, held) => {
      const key = ufvk();
      if (held) {
        return (
          await completeColdDepositInWorker(c.storeId, c.zidecarUrl, r, key, { txHex: held.txHex })
        ).txid;
      }
      const ask = await buildColdDepositInWorker(c.storeId, c.zidecarUrl, r, key);
      const signed = await round.sign(ask, PAY_LABEL);
      return (
        await completeColdDepositInWorker(c.storeId, c.zidecarUrl, r, key, {
          unsignedPcztHex: ask.pcztHex,
          signedPcztHex: signed,
        })
      ).txid;
    },
  };
};

/** run a swap's legs for this wallet; `reviewed` is the plan the person confirmed */
export const runSwapLegs = (swap: OpenSwap, c: LegContext, reviewed?: DepositPlan): void =>
  startThorOut(
    swap,
    (c.cold ? coldLegs : hotLegs)(c, swap),
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
  const c = legContextOf(s);
  if (c) {
    runSwapLegs(swap, c);
  }
};
