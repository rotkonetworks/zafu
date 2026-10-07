/**
 * A zigner wallet's move and the thorchain deposit that spends it, in one QR
 * round. The move (shielded -> the swap's own t-address) has no transparent
 * inputs, so its txid is known from the unsigned PCZT (ZIP 244; zcli
 * tests/move_txid_before_signing.rs). The deposit is built against the
 * move's output at once, both ride one batch (zigner tests/swap_one_round.rs),
 * and both come back signed.
 *
 * Nothing leaves before every check holds: the deposit pays exactly the
 * review and spends the move's coin, the move extracts to the txid the
 * deposit spends. The signed deposit is held (sealed, by the caller's
 * `hold`) BEFORE the move is broadcast, and is broadcast only once the move
 * is mined: no mempool chaining is relied on.
 */

import type { ZignerRequest } from './zigner-round';
import {
  MOVE_MISMATCH,
  moveCoin,
  transparentInputs,
  type MoveCoin,
  type MoveInspected,
} from '../workers/transparent-deposit';

/** a signed deposit waiting for its move to be mined */
export interface Held {
  txHex: string;
  /** the last height the deposit can be mined at */
  expiry: number;
  moveTxid: string;
  /** the last height the move can be mined at; past it, the move never lands */
  moveExpiry: number;
}

/** the move as the worker built it for zigner */
export interface BuiltMove {
  /** the PCZT zafu keeps */
  pcztHex: string;
  /** the full module envelope `[0x53][0x04][0x03] || pczt`: the copy the device signs */
  cborData?: Uint8Array;
  compactRequest?: boolean;
  coldSendId?: string;
}

export interface PairDeps {
  buildMove: () => Promise<BuiltMove>;
  inspect: (pcztHex: string) => Promise<MoveInspected>;
  /** the deposit spending `coin`, and the one batch request carrying `movePczt` and it */
  buildDeposit: (coin: MoveCoin, movePcztHex: string) => Promise<ZignerRequest>;
  /** the round: both signed PCZTs, request order */
  sign: (req: ZignerRequest) => Promise<string[]>;
  /** the deposit's checked, signed bytes, not broadcast */
  finishDeposit: (
    unsignedPcztHex: string,
    signedPcztHex: string,
  ) => Promise<{
    txHex: string;
    expiry: number;
  }>;
  extract: (signedPcztHex: string) => Promise<{ txHex: string; txid: string }>;
  /** keep the signed deposit, sealed; undefined lets it go */
  hold: (held: Held | undefined) => Promise<unknown>;
  broadcastMove: (txHex: string, coldSendId?: string) => Promise<string>;
}

/** the PCZT inside a full single request, the bytes the device would sign, as hex */
const devicePczt = (m: BuiltMove): string => {
  const e = m.cborData;
  if (m.compactRequest || !e || e[0] !== 0x53 || e[1] !== 0x04 || e[2] !== 0x03) {
    throw new Error('this move asked zigner in a shape a batch cannot carry · nothing was sent');
  }
  return Array.from(e.subarray(3), b => b.toString(16).padStart(2, '0')).join('');
};

/** sign both, check both, hold the deposit, then send the move: the move's txid */
export const moveAndDeposit = async (
  d: PairDeps,
  tAddress: string,
  shortZat: string,
): Promise<string> => {
  const move = await d.buildMove();
  const coin = moveCoin(await d.inspect(move.pcztHex), tAddress, shortZat);
  const ask = await d.buildDeposit(coin, devicePczt(move));
  const [signedMove, signedDeposit] = await d.sign(ask);
  const deposit = await d.finishDeposit(ask.pcztHex, signedDeposit!);
  const moved = await d.extract(signedMove!);
  if (
    moved.txid !== coin.txid ||
    !transparentInputs(deposit.txHex).some(i => i.txid === coin.txid && i.vout === coin.vout)
  ) {
    throw new Error(MOVE_MISMATCH);
  }
  await d.hold({ ...deposit, moveTxid: coin.txid, moveExpiry: coin.expiry });
  try {
    await d.broadcastMove(moved.txHex, move.coldSendId);
  } catch (e) {
    // the node refused it: nothing moved, so nothing is held for it
    if (e instanceof Error && e.message.startsWith('broadcast failed')) {
      await d.hold(undefined);
    }
    throw e;
  }
  return coin.txid;
};

export type HeldNext = 'wait' | 'pay' | 'drop' | 'lost';

/**
 * Blocks past the move's expiry before it counts as lost: a mined move the
 * light client has not indexed yet must never look lost, or a second move
 * would follow it.
 */
export const LOST_AFTER = 3;

/**
 * Blocks a held deposit outlives its move. A move mined in its own last block
 * and seen LOST_AFTER blocks late still leaves the deposit the next block, with
 * zcashd's 3-block "expiring soon" relay rule to spare (zebra has none).
 */
export const DEPOSIT_OUTLIVES_MOVE = LOST_AFTER + 1 + 3;

/**
 * What a held deposit does next, from the chain alone. The move mined and the
 * deposit can still land in the next block: pay. Mined too late for it: drop
 * it (the coin is on the address; a fresh deposit is signed). Not mined yet:
 * wait, until the move itself can no longer land, with LOST_AFTER blocks to
 * spare: lost (nothing left the wallet; sign again).
 */
export const heldNext = (held: Held, minedAt: number | undefined, tip: number): HeldNext =>
  minedAt !== undefined
    ? tip + 1 <= held.expiry
      ? 'pay'
      : 'drop'
    : tip > held.moveExpiry + LOST_AFTER
      ? 'lost'
      : 'wait';
