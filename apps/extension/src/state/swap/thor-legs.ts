/**
 * The two legs of a thorchain swap out of zec, per wallet kind: a hot wallet
 * signs in the worker under the swap's one unlock, a zigner wallet one qr
 * round per leg (the move over the module envelope, then the reviewed
 * deposit, finished and checked here before broadcast). The run that drives
 * them is ./thor-out; this is where the kind is chosen, once.
 */

import type { AllSlices } from '..';
import { selectEffectiveKeyInfo } from '../keyring';
import { selectTxSigningSecurity } from '../privacy';
import {
  applySignatureContributionsInWorker,
  buildColdDepositInWorker,
  buildSendTxInWorker,
  buildSendTxPcztInWorker,
  completeColdDepositInWorker,
  planTransparentDepositInWorker,
  sendTransparentDepositInWorker,
  type SignatureContribution,
} from '../keyring/network-worker';
import type { VaultUnlock } from '../keyring/types';
import { activeAccountIndex, activeZcashStoreId } from '../pockets';
import { selectActiveZcashWallet } from '../wallets';
import { walletKind } from '../../signing/wallet-kind';
import { signAndBroadcast } from '../../signing/cold-send';
import { createZignerRound, type ZignerRound } from '../../signing/zigner-round';
import { checkVault, type DepositPlan } from '../../workers/transparent-deposit';
import { patchOpenSwap, type OpenSwap } from './open-swaps';
import { isRunning, legsPerUnlock, startThorOut, takeSwapUnlock, type Legs } from './thor-out';

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
export const MOVE_LABEL = 'move zec to the swap address';
export const PAY_LABEL = 'the swap deposit';

const coldLegs = (c: LegContext, swap: OpenSwap): Legs => {
  const round = swapRound(swap.id, c.storeId);
  const ufvk = () => {
    if (!c.ufvk) {
      throw new Error('this zigner wallet has no viewing key here · please re-import it');
    }
    return c.ufvk;
  };
  return {
    // the device is the confirmation: each leg is approved there
    ready: () => Promise.resolve(true),
    move: async short => {
      const built = await buildSendTxPcztInWorker(
        'zcash',
        c.storeId,
        c.zidecarUrl,
        swap.swapT!.address,
        short,
        '',
        0,
        true,
        ufvk(),
        false,
        undefined,
        undefined,
        true,
      );
      const sent = await signAndBroadcast(round.signer(built, MOVE_LABEL), built, {
        walletId: c.storeId,
        zidecarUrl: c.zidecarUrl,
        mainnet: true,
      });
      return sent.txid;
    },
    pay: async req => {
      const key = ufvk();
      const ask = await buildColdDepositInWorker(c.storeId, c.zidecarUrl, req, key);
      const signed = await round.sign(ask, PAY_LABEL);
      const sent = await completeColdDepositInWorker(
        c.storeId,
        c.zidecarUrl,
        req,
        key,
        ask.pcztHex,
        signed,
      );
      return sent.txid;
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
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      now: Date.now,
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
