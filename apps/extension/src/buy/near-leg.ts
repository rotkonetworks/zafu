/**
 * The last leg: the person's Base USDC into shielded zec through NEAR 1Click.
 * Quoted fresh once the usdc is on their address (never sent from Peer
 * straight to a deposit address: the intent can outlive 1click's deadline).
 * zafu's fee is charged once per buy, on the Peer side, so this leg carries
 * no zafu app fee. A failed swap refunds to the person's own Base address.
 */

import { checkSwapStatus, requestQuote, submitDepositTx } from '../state/near-swap';
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
    slippageTolerance: 100,
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

/** a real quote with a deposit address, for the usdc that arrived */
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
    slippageTolerance: 100,
    appFeeBps: 0,
  });
  if (!r.quote.depositAddress) {
    throw new Error('near intents gave no deposit address');
  }
  const inUsd = units6(r.quote.amountInUsd);
  const outUsd = units6(r.quote.amountOutUsd);
  return {
    cost: (inUsd > outUsd ? inUsd - outUsd : 0n).toString(),
    depositAddress: r.quote.depositAddress,
    amountIn: r.quote.amountIn,
    amountOut: r.quote.amountOut,
    minAmountOut: r.quote.minAmountOut ?? r.quote.amountOut,
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
