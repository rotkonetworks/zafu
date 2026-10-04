/**
 * The last leg: the person's Base USDC into shielded zec through NEAR 1Click.
 * Quoted fresh once the usdc is on their address (never sent from Peer
 * straight to a deposit address: the intent can outlive 1click's deadline).
 * zafu's fee is charged once per buy, on the Peer side, so this leg carries
 * no zafu app fee. A failed swap refunds to the person's own Base address.
 */

import {
  checkSwapStatus,
  requestQuote,
  submitDepositTx,
  type SwapQuoteResponse,
} from '../state/near-swap';
import type { NearLeg } from './machine';
import type { Facts } from './machine';

export const NEAR_BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
export const NEAR_ZEC = 'nep141:zec.omft.near';

export interface SwapEstimate {
  /** zec out, 8 decimals */
  amountOut: bigint;
  /** what near's leg costs, in usdc units (6 decimals) */
  cost: bigint;
  timeEstimate?: number;
}

/** the slippage the leg asks 1click for, in bps; its floor must say the same */
const LEG_SLIPPAGE_BPS = 100;
/** a quote that runs out sooner than this can't be sent into safely */
export const LEG_MIN_WINDOW_MS = 10 * 60_000;

const units6 = (usd: string | undefined): bigint =>
  usd && Number.isFinite(Number(usd)) ? BigInt(Math.round(Number(usd) * 1e6)) : 0n;

/** a dry quote: what `usdc` would become, no deposit address issued */
export const estimateSwap = async (
  usdc: bigint,
  base: `0x${string}`,
  zcash: string,
): Promise<SwapEstimate> => {
  const r = await requestQuote({
    dry: true,
    swapType: 'EXACT_INPUT',
    amount: usdc.toString(),
    originAsset: NEAR_BASE_USDC,
    destinationAsset: NEAR_ZEC,
    recipient: zcash,
    refundTo: base,
    slippageTolerance: LEG_SLIPPAGE_BPS,
    appFeeBps: 0,
  });
  const inUsd = units6(r.quote.amountInUsd);
  const outUsd = units6(r.quote.amountOutUsd);
  return {
    amountOut: BigInt(r.quote.amountOut || '0'),
    cost: inUsd > outUsd ? inUsd - outUsd : 0n,
    timeEstimate: r.quote.timeEstimate,
  };
};

/**
 * Throws unless 1click's answer is the swap zafu asked for: the exact usdc
 * amount (it decides what is sent, so it is never taken on trust), a Base
 * deposit address, the same assets, recipient and refund address, a deadline
 * with time to send in, and a guaranteed floor that matches the slippage
 * asked. Nothing is signed on a mismatch.
 */
export const checkLeg = (
  r: SwapQuoteResponse,
  want: { usdc: bigint; base: `0x${string}`; zcash: string },
  now = Date.now(),
): void => {
  const q = r.quote;
  const refuse = (why: string) => {
    throw new Error(`near intents' quote ${why} · nothing was sent`);
  };
  if (!q.depositAddress) {
    refuse('has no deposit address');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(q.depositAddress)) {
    refuse("names a deposit address that isn't on base");
  }
  if (q.amountIn !== want.usdc.toString()) {
    refuse('asks for another amount than the usdc that arrived');
  }
  const asked = r.quoteRequest as Partial<SwapQuoteResponse['quoteRequest']> | undefined;
  if (
    asked &&
    (asked.originAsset !== NEAR_BASE_USDC ||
      asked.destinationAsset !== NEAR_ZEC ||
      asked.recipient !== want.zcash ||
      asked.refundTo?.toLowerCase() !== want.base.toLowerCase() ||
      asked.dry)
  ) {
    refuse('is for another swap than the one asked');
  }
  // a real quote carries its deadline; failing that, the one the echoed request asked for
  // (a dry quote, checked live 2026-10-04, echoes the request's and has none of its own)
  const deadline = Date.parse(q.deadline ?? asked?.deadline ?? '');
  if (!Number.isFinite(deadline) || deadline < now + LEG_MIN_WINDOW_MS) {
    refuse('runs out too soon');
  }
  const out = /^\d+$/.test(q.amountOut) ? BigInt(q.amountOut) : 0n;
  const min = /^\d+$/.test(q.minAmountOut ?? '') ? BigInt(q.minAmountOut!) : 0n;
  // the floor is the slippage asked below what it quotes, never lower (rounding allowed)
  if (
    !out ||
    !min ||
    min > out ||
    min * 10_000n < out * BigInt(10_000 - LEG_SLIPPAGE_BPS) - 10_000n
  ) {
    refuse('guarantees less than the slippage zafu asked for');
  }
};

/** a real quote with a deposit address, for the usdc that arrived; checked before anything is sent */
export const quoteSwap = async (
  usdc: bigint,
  base: `0x${string}`,
  zcash: string,
): Promise<NearLeg> => {
  const r = await requestQuote({
    swapType: 'EXACT_INPUT',
    amount: usdc.toString(),
    originAsset: NEAR_BASE_USDC,
    destinationAsset: NEAR_ZEC,
    recipient: zcash,
    refundTo: base,
    slippageTolerance: LEG_SLIPPAGE_BPS,
    appFeeBps: 0,
  });
  checkLeg(r, { usdc, base, zcash });
  const inUsd = units6(r.quote.amountInUsd);
  const outUsd = units6(r.quote.amountOutUsd);
  return {
    cost: (inUsd > outUsd ? inUsd - outUsd : 0n).toString(),
    depositAddress: r.quote.depositAddress,
    amountIn: r.quote.amountIn,
    amountOut: r.quote.amountOut,
    minAmountOut: r.quote.minAmountOut!,
    timeEstimate: r.quote.timeEstimate,
    quotedAt: Date.now(),
    deadline: r.quote.deadline,
  };
};

/** tell 1click the deposit is in, so it starts without waiting to notice */
export const announceDeposit = (tx: string, depositAddress: string): Promise<void> =>
  submitDepositTx(tx, depositAddress).catch(() => undefined);

export const swapFacts = async (
  depositAddress: string,
): Promise<Pick<Facts, 'swap' | 'swapOut' | 'noDeposit'>> => {
  const s = await checkSwapStatus(depositAddress);
  const swap =
    s.status === 'SUCCESS'
      ? 'success'
      : s.status === 'REFUNDED'
        ? 'refunded'
        : s.status === 'FAILED'
          ? 'failed'
          : 'pending';
  return {
    swap,
    noDeposit: !s.status || s.status === 'PENDING_DEPOSIT',
    swapOut: s.swapDetails?.amountOut,
  };
};
