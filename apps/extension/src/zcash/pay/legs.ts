/**
 * The two legs of a payment from a fresh transparent address, per wallet
 * kind: a hot wallet signs in the worker under the payment's one unlock, a
 * zigner wallet in one qr round for both (signing/move-and-deposit): the
 * move goes at once, the payment is held until the move is mined. The run
 * that drives them is ./via-fresh; this is where the kind is chosen, once.
 */

import type { AllSlices } from '../../state';
import { selectEffectiveKeyInfo } from '../../state/keyring';
import { selectTxSigningSecurity } from '../../state/privacy';
import {
  broadcastSignedTxInWorker,
  buildColdDepositInWorker,
  buildSendTxInWorker,
  buildSendTxPcztInWorker,
  completeColdDepositInWorker,
  extractSignedPcztTxInWorker,
  frostInspectPcztOutputsInWorker,
  holdColdDepositInWorker,
  sendTransparentDepositInWorker,
} from '../../state/keyring/network-worker';
import type { VaultUnlock } from '../../state/keyring/types';
import { activeAccountIndex, activeZcashStoreId } from '../../state/pockets';
import { selectActiveZcashWallet } from '../../state/wallets';
import { zcashViewKey } from '../../state/zcash-view-key';
import { selectZcashEndpoint } from '../../state/networks';
import { walletKind } from '../../signing/wallet-kind';
import { moveAndDeposit } from '../../signing/move-and-deposit';
import type { ZignerRound } from '../../signing/zigner-round';
import { zignerRound } from '../../signing/zigner-pay';
import type { MoveInspected } from '../../workers/transparent-deposit';
import { legsPerUnlock, takePayUnlock, type FreshPayment, type Legs } from './via-fresh';

/** what signing a payment's legs needs from the wallet, read once from the store */
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
    zidecarUrl: selectZcashEndpoint(s),
    ufvk: zcashViewKey(zw),
    cold: walletKind(key, zw) === 'zigner',
    legsPerUnlock: legsPerUnlock(selectTxSigningSecurity(s)),
    getVaultUnlock: s.keyRing.getVaultUnlock,
  };
};

/** what the device's round says it signs */
export interface LegLabels {
  /** both legs in one round */
  pair: string;
  /** the payment alone */
  pay: string;
}

const hotLegs = (c: LegContext, p: FreshPayment): Legs => ({
  ready: () => takePayUnlock(p.id),
  move: async short => {
    const sent = await buildSendTxInWorker(
      'zcash',
      c.storeId,
      c.zidecarUrl,
      p.req.tAddress,
      short,
      '',
      c.pocket,
      p.req.mainnet,
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

/** each payment's device round, kept while its run lives so the tracker shows it */
const rounds = new Map<string, ZignerRound>();

export const payRound = (id: string, storeId: string): ZignerRound => {
  let round = rounds.get(id);
  if (!round) {
    round = zignerRound(() => storeId);
    rounds.set(id, round);
  }
  return round;
};

const coldLegs = (c: LegContext, p: FreshPayment, labels: LegLabels): Legs => {
  const round = payRound(p.id, c.storeId);
  const ufvk = () => {
    if (!c.ufvk) {
      throw new Error('this zigner wallet has no viewing key here · please re-import it');
    }
    return c.ufvk;
  };
  const { req } = p;
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
              req.mainnet,
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
          sign: ask => round.signBatch(ask, 2, labels.pair),
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
      const signed = await round.sign(ask, labels.pay);
      return (
        await completeColdDepositInWorker(c.storeId, c.zidecarUrl, r, key, {
          unsignedPcztHex: ask.pcztHex,
          signedPcztHex: signed,
        })
      ).txid;
    },
  };
};

/** the wallet's own legs for a payment */
export const legsFor = (c: LegContext, p: FreshPayment, labels: LegLabels): Legs =>
  c.cold ? coldLegs(c, p, labels) : hotLegs(c, p);
