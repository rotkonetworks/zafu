/**
 * ZEC liquidity on THORChain, the arithmetic. Every formula here is a port
 * of THORNode's own (v3.20.3, x/thorchain): pool units on an add
 * (handler_add_liquidity.go calculatePoolUnits), and the withdraw of an
 * asset-only position, whose rune half is swapped through the pool into zec
 * (withdraw.go calculateWithdraw, swap_current.go GetSwapCalc). Amounts are
 * base units (zat, 1e8 rune); prices are usd per whole coin.
 */

import { memoBytes, MAX_MEMO_BYTES } from '../state/swap/thornode';

export const LP_POOL = 'ZEC.ZEC';

/** a single-sided add: credited to the transparent address that sends it */
export const ADD_MEMO = `+:${LP_POOL}`;

/** a withdraw, sent as dust from that same address; bps of the position, 1..10000 */
export const withdrawMemo = (bps: number): string => {
  if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) {
    throw new Error(`withdraw basis points ${bps} are not valid`);
  }
  return `-:${LP_POOL}:${bps}`;
};

/** an OP_RETURN carries at most 80 bytes: a memo past that is refused before anything moves */
export const memoFits = (memo: string): boolean => memoBytes(memo) <= MAX_MEMO_BYTES;

/** the founder's minimum add: below it the return fee and network fees eat most of it */
export const MIN_ADD_ZAT = 200_000n;

/** the most a take-out's ask may pay, zat (0.001 zec): a dust past this is refused, never paid */
export const MAX_ASK_ZAT = 100_000n;
/** the least an ask pays, zat, whatever the dust: a zcash output worth relaying */
const MIN_ASK_ZAT = 10_000n;

/**
 * The take-out ask, from the chain's dust threshold read at send time.
 * THORChain does not observe an inbound at or under the dust (the swap path
 * asks for dust + 1 for the same reason), so the ask pays twice the dust:
 * safely above it, should the threshold move a little between the confirm
 * and the send. Undefined when that is past MAX_ASK_ZAT.
 */
export const askZat = (dust: bigint): bigint | undefined => {
  const a = dust * 2n > MIN_ASK_ZAT ? dust * 2n : MIN_ASK_ZAT;
  return dust >= 0n && a <= MAX_ASK_ZAT ? a : undefined;
};

/** an ask still pays above the dust read now, within the cap */
export const askClears = (ask: bigint, dust: bigint): boolean => ask > dust && ask <= MAX_ASK_ZAT;

/** the default amount on the add screen */
export const DEFAULT_ADD = '0.01';
/** cost vs market: orange from here */
export const WARN_COST_PCT = 5;
/** strong: the confirm turns to "add anyway" and a smaller amount is offered */
export const STRONG_COST_PCT = 10;
/** the smaller amount offered on a strong cost lands about here */
export const FAIR_COST_PCT = 3;

/** a pool as THORNode reports it */
export interface PoolDepth {
  /** zec side, zat */
  asset: bigint;
  /** rune side, 1e8 */
  rune: bigint;
  /** pool units (LP units + synth units) */
  units: bigint;
}

/**
 * The units an add earns: P (rA + aR + 2ra) / (rA + aR + 2RA), truncated.
 * A first deposit into an empty pool keeps a rune scale, as THORNode does.
 */
export const poolUnitsFor = (pool: PoolDepth, addAsset: bigint, addRune = 0n): bigint => {
  const { units: P, rune: R, asset: A } = pool;
  if (R === 0n || A === 0n || P === 0n) {
    return addRune || (A ? (addAsset * R) / A : addAsset);
  }
  const cross = addRune * A + addAsset * R;
  return (P * (cross + 2n * addRune * addAsset)) / (cross + 2n * A * R);
};

/** THORNode's GetSafeShare: allocation * part / total, floored; zero over zero */
const share = (part: bigint, total: bigint, allocation: bigint): bigint =>
  total === 0n ? 0n : (allocation * part) / total;

/** CalcSwapSlip: x / (x + X), in basis points, rounded half away from zero */
const swapSlipBps = (X: bigint, x: bigint): bigint => {
  const d = x + X;
  return d === 0n ? 0n : (x * 20_000n + d) / (2n * d);
};

/**
 * GetSwapCalc: x in against X, Y out. Below the minimum slip floor the fee is
 * the floor's share of x Y / (x + X); above it, the constant-product emission.
 */
export const swapOut = (X: bigint, x: bigint, Y: bigint, minSlipBps: bigint): bigint => {
  const d = x + X;
  if (d === 0n) {
    return 0n;
  }
  if (minSlipBps > swapSlipBps(X, x)) {
    const fee = share(minSlipBps, 10_000n, x * Y) / d;
    const emit = (x * Y) / d;
    return emit > fee ? emit - fee : 0n;
  }
  return (x * X * Y) / (d * d);
};

/**
 * What a withdraw of `bps` of an asset-only position pays, in zat, before the
 * outbound fee: its asset share, plus its rune share swapped into zec through
 * what remains of the pool.
 */
export const withdrawZec = (
  pool: PoolDepth,
  lpUnits: bigint,
  bps: number,
  minSlipBps: bigint,
): bigint => {
  if (pool.units === 0n || pool.rune === 0n || pool.asset === 0n || lpUnits === 0n) {
    return 0n;
  }
  const claim = share(BigInt(bps), 10_000n, lpUnits);
  const outRune = share(claim, pool.units, pool.rune);
  const outAsset = share(claim, pool.units, pool.asset);
  return swapOut(pool.rune - outRune, outRune, pool.asset - outAsset, minSlipBps) + outAsset;
};

/** what comes back after the pool's outbound fee: never below zero */
export const afterFee = (zat: bigint, outboundFee: bigint): bigint =>
  zat > outboundFee ? zat - outboundFee : 0n;

/** the pool once `addAsset` zat sits in it, and the units that add earned */
export const afterAdd = (pool: PoolDepth, addAsset: bigint) => {
  const units = poolUnitsFor(pool, addAsset);
  return {
    units,
    pool: { asset: pool.asset + addAsset, rune: pool.rune, units: pool.units + units },
  };
};

export interface AddQuote {
  units: bigint;
  /** of the pool, percent */
  sharePct: number;
  /** what the position is worth at market against what was put in; undefined with no market price */
  costPct?: number;
  /** the market value lost, usd */
  lostUsd?: number;
}

/** usd per whole zec and per whole rune: the market's zec, THORChain's own rune */
export interface Prices {
  zec: number;
  rune: number;
}

/**
 * An add of `a` zat: its units and share from THORNode's formula, and its
 * cost against the market. The position is valued at market as its claim on
 * both sides of the pool once the add sits in it; the cost is what that
 * claim is short of the zec put in, also at market.
 */
export const quoteAdd = (pool: PoolDepth, a: bigint, px?: Prices): AddQuote | undefined => {
  if (a <= 0n) {
    return undefined;
  }
  const { units, pool: p } = afterAdd(pool, a);
  const sh = Number(units) / Number(p.units);
  if (!px) {
    return { units, sharePct: sh * 100 };
  }
  const put = (Number(a) / 1e8) * px.zec;
  const worth = sh * ((Number(p.asset) / 1e8) * px.zec + (Number(p.rune) / 1e8) * px.rune);
  const costPct = (1 - worth / put) * 100;
  return { units, sharePct: sh * 100, costPct, lostUsd: put - worth };
};

/** the largest add, in whole 0.001 zec, whose cost stays at or under `pct` */
export const fairAmount = (pool: PoolDepth, px: Prices, pct = FAIR_COST_PCT): bigint => {
  const step = 100_000n;
  let lo = 1n;
  let hi = pool.asset > step ? pool.asset / step : 1n;
  if ((quoteAdd(pool, lo * step, px)?.costPct ?? 0) > pct) {
    return step;
  }
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((quoteAdd(pool, mid * step, px)?.costPct ?? 0) <= pct) {
      lo = mid;
    } else {
      hi = mid - 1n;
    }
  }
  return lo * step;
};

/** cost tones: orange from 5%, strong from 10% */
export const costTone = (pct?: number): 'calm' | 'warn' | 'strong' =>
  pct === undefined || pct < WARN_COST_PCT ? 'calm' : pct < STRONG_COST_PCT ? 'warn' : 'strong';

/**
 * How far zec has moved against rune since the add, from THORNode's deposit
 * values (both halves, at the add's pool price) and the pool now. Positive:
 * zec is higher against rune, so less zec comes back.
 */
export const zecMoveSinceAdd = (
  pool: PoolDepth,
  depositAsset: bigint,
  depositRune: bigint,
): number | undefined => {
  if (!depositAsset || !depositRune || !pool.asset) {
    return undefined;
  }
  const then = Number(depositRune) / Number(depositAsset);
  const now = Number(pool.rune) / Number(pool.asset);
  return now / then - 1;
};

/** what a 50/50 holding lost to a relative price move of `move`, against holding both */
export const impermanentLoss = (move: number): number => {
  const k = 1 + move;
  return k > 0 ? (2 * Math.sqrt(k)) / (1 + k) - 1 : -1;
};

/** whole zec from a decimal string, as zat; undefined when it isn't a positive amount */
export const parseZec = (text: string): bigint | undefined => {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || !/\d/.test(t)) {
    return undefined;
  }
  const [whole = '0', frac = ''] = t.split('.');
  if (frac.length > 8) {
    return undefined;
  }
  const zat = BigInt(whole || '0') * 100_000_000n + BigInt((frac + '00000000').slice(0, 8));
  return zat > 0n ? zat : undefined;
};

/** zat as zec: four places from 0.01, five below it */
export const zecText = (zat: bigint): string => {
  const n = Number(zat) / 1e8;
  return n >= 0.01 ? n.toFixed(4) : n.toFixed(5);
};

/** THORChain's own rune, in a memo's asset slot */
export const RUNE_POOL_ASSET = 'THOR.RUNE';

/**
 * A two-sided add: each half names the other half's address (THORNode
 * memo_add.go, `+:POOL:PAIREDADDR`). The zec half names the thor1, the rune
 * half names the zec lp t-address; THORNode keys the position by the thor1
 * and holds whichever half lands first as pending until the other comes.
 */
export const pairedAddMemo = (otherAddress: string): string => `${ADD_MEMO}:${otherAddress}`;

/** how a two-sided take-out pays: both sides at the pool price, or all in one (memo_withdraw.go `:ASSET`) */
export type PayoutAs = 'both' | 'zec' | 'rune';

/** sent from the thor1 with 0 rune: THORNode finds the position by the sender (handler.go getMsgWithdrawFromMemo) */
export const pairedWithdrawMemo = (bps: number, as: PayoutAs = 'both'): string =>
  `${withdrawMemo(bps)}${as === 'zec' ? `:${LP_POOL}` : as === 'rune' ? `:${RUNE_POOL_ASSET}` : ''}`;

/**
 * Takes back a half that is waiting for the other: with no units, THORNode's
 * withdraw removes the pending record and pays the pending rune to the thor1
 * and any pending zec to the lp address (withdraw.go, lp.Units == 0).
 */
export const RECOVER_MEMO = withdrawMemo(10_000);

/** the rune that pairs `zat` at the pool's ratio, 1e8 */
export const runeFor = (pool: PoolDepth, zat: bigint): bigint =>
  pool.asset > 0n ? (zat * pool.rune) / pool.asset : 0n;

/** the zec that pairs `rune` at the pool's ratio, zat */
export const zecFor = (pool: PoolDepth, rune: bigint): bigint =>
  pool.rune > 0n ? (rune * pool.asset) / pool.rune : 0n;

/** how far a pair is off the pool's ratio, percent of the rune it should carry; the off part is paid as slip */
export const offRatioPct = (pool: PoolDepth, zat: bigint, rune: bigint): number => {
  const want = runeFor(pool, zat);
  return want > 0n ? (Number(rune - want) / Number(want)) * 100 : 0;
};

/** a two-sided add's units and share, by THORNode's own formula */
export const quotePaired = (pool: PoolDepth, zat: bigint, rune: bigint, px?: Prices) => {
  if (zat <= 0n || rune <= 0n) {
    return undefined;
  }
  const units = poolUnitsFor(pool, zat, rune);
  const after = { asset: pool.asset + zat, rune: pool.rune + rune, units: pool.units + units };
  const sh = Number(units) / Number(after.units);
  if (!px) {
    return { units, sharePct: sh * 100 };
  }
  const put = (Number(zat) / 1e8) * px.zec + (Number(rune) / 1e8) * px.rune;
  const worth = sh * ((Number(after.asset) / 1e8) * px.zec + (Number(after.rune) / 1e8) * px.rune);
  return { units, sharePct: sh * 100, costPct: (1 - worth / put) * 100 };
};

/**
 * What a two-sided take-out of `bps` pays, before the outbound fees: both
 * shares as they are, or one side swapped into the other through what
 * remains of the pool (withdraw.go calculateWithdraw with a withdrawal asset).
 */
export const pairedWithdraw = (
  pool: PoolDepth,
  lpUnits: bigint,
  bps: number,
  minSlipBps: bigint,
  as: PayoutAs,
): { zat: bigint; rune: bigint } => {
  if (pool.units === 0n || pool.rune === 0n || pool.asset === 0n || lpUnits === 0n) {
    return { zat: 0n, rune: 0n };
  }
  const claim = share(BigInt(bps), 10_000n, lpUnits);
  const outRune = share(claim, pool.units, pool.rune);
  const outAsset = share(claim, pool.units, pool.asset);
  if (as === 'zec') {
    return { zat: withdrawZec(pool, lpUnits, bps, minSlipBps), rune: 0n };
  }
  if (as === 'rune') {
    return {
      zat: 0n,
      rune: swapOut(pool.asset - outAsset, outAsset, pool.rune - outRune, minSlipBps) + outRune,
    };
  }
  return { zat: outAsset, rune: outRune };
};

/** rune as text: two places from 1, four below */
export const runeText = (base: bigint): string => {
  const n = Number(base) / 1e8;
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
};

/** whole rune from a decimal string, as 1e8; undefined when it isn't a positive amount */
export const parseRune = parseZec;
