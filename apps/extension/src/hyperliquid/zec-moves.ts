/**
 * ZEC on its way into or out of Hyperliquid through Unit, between visits:
 * what was sent and the transaction Unit will know it by. Sealed at rest
 * (ENCRYPTED_KEYS 'hyperliquidZecMoves'). A record is forgotten once Unit
 * says the move is done; the balance says the rest. Not a setting, so not
 * in the personal backup.
 */

import type { UnitOperation } from '@repo/wallet/networks/hyperliquid/unit';
import { sealedList } from '../state/sealed-list';

export interface ZecMove {
  v: 1;
  id: string;
  way: 'deposit' | 'withdraw';
  /** the hyperliquid account it credits or leaves */
  account: string;
  zat: string;
  /** when it was sent */
  at: number;
  /**
   * as Unit names the source: the zcash txid, or `account:nonce` on
   * hyperliquid. Empty while a deposit's payment has not left zcash yet.
   */
  tx: string;
}

const isZecMove = (v: unknown): v is ZecMove => {
  const m = v as ZecMove;
  return (
    !!m &&
    typeof m === 'object' &&
    m.v === 1 &&
    typeof m.id === 'string' &&
    (m.way === 'deposit' || m.way === 'withdraw') &&
    typeof m.account === 'string' &&
    /^\d+$/.test(m.zat) &&
    typeof m.at === 'number' &&
    typeof m.tx === 'string'
  );
};

/** a deposit whose payment never told its txid (let go, or sent while no screen watched) is dropped after a day */
const UNSENT_KEPT_MS = 24 * 3_600_000;

export const zecMoves = sealedList(
  'hyperliquidZecMoves',
  isZecMove,
  m => !m.tx && Date.now() - m.at > UNSENT_KEPT_MS,
);

/** what a zec deposit through Unit means, said on its review */
export const UNIT_DEPOSIT_LINES = [
  'a deposit to hyperliquid, through unit',
  'it leaves the shielded pool and is public from there',
  "unit's guardians keep the zec while it is on hyperliquid",
  "it arrives as uzec in your spot account, less unit's network fee",
  'unit waits 300 confirmations · about two hours',
];

/** zcash confirmations Unit waits for (docs.hyperunit.xyz: api, required confirmations) */
const ZCASH_CONFIRMATIONS = 300;

/** Unit's state words, in zafu's; a state not here reads as on its way */
const STATE: Record<string, (o: UnitOperation) => string> = {
  sourceTxDiscovered: () => 'unit has seen it',
  waitForSrcTxFinalization: o =>
    o.way === 'deposit' && o.confirmations !== undefined
      ? `${o.confirmations} of ${ZCASH_CONFIRMATIONS} confirmations`
      : 'waiting for confirmations',
  readyForWithdrawQueue: () => "in unit's withdrawal queue",
  queuedForWithdraw: () => 'unit sent the zec · waiting for its block',
  done: () => 'arrived',
  failure: () => 'unit could not complete this · it can be reverted at unit',
};

/**
 * Unit lists a zcash source as `txid:vout`, a hyperliquid one as
 * `sender:nonce`. A deposit with no txid yet is known by its exact amount,
 * among operations Unit made after it was started.
 */
const operationOf = (m: ZecMove, ops: readonly UnitOperation[]): UnitOperation | undefined =>
  ops.find(
    o =>
      o.way === m.way &&
      (m.tx
        ? o.sourceTx.toLowerCase().startsWith(m.tx.toLowerCase())
        : o.zat === BigInt(m.zat) && Date.parse(o.createdAt) >= m.at),
  );

export interface ZecMoveStatus {
  line: string;
  /** Unit will not change it again */
  over: boolean;
  failed: boolean;
}

/** where a move stands; `ops` undefined while Unit has not been asked or did not answer */
export const zecMoveStatus = (
  m: ZecMove,
  ops: readonly UnitOperation[] | undefined,
): ZecMoveStatus => {
  const o = ops && operationOf(m, ops);
  const line = !ops
    ? 'unit has not been asked yet'
    : !o
      ? !m.tx
        ? 'leaving your zcash wallet'
        : m.way === 'deposit'
          ? 'sent · unit sees it after its first block'
          : 'sent · unit has not picked it up yet'
      : (STATE[o.state]?.(o) ?? 'unit is sending it on');
  return {
    line,
    over: o?.state === 'done' || o?.state === 'failure',
    failed: o?.state === 'failure',
  };
};
