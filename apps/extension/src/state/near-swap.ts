/**
 * NEAR 1Click crosschain swap API client
 *
 * Uses ChainDefuser's 1Click API (same as Zashi mobile) for
 * crosschain swaps to/from ZEC. The API handles routing through
 * NEAR's intent infrastructure - we just request quotes and send
 * ZEC to the deposit address.
 *
 * Flow:
 *   1. GET /v0/tokens - list supported assets
 *   2. POST /v0/quote - get quote with deposit address
 *   3. User sends ZEC to deposit address (or receives at their address)
 *   4. GET /v0/status?depositAddress=... - poll for completion
 */

import { requestEgressOptIn } from '../net/egress-opt-in';
import { NEAR_APP_FEE_RECIPIENT } from '../config/swap-fee';

const API_BASE = 'https://1click.chaindefuser.com';

// 1Click partner JWT - partner_id: rotko-networks (issued via NEAR Intents portal).
// Sent as `Authorization: Bearer <jwt>` on quote/status/deposit to avoid the 0.2% fee
// and attribute swaps to rotko.
//
// Token value is NEVER committed to the repo. It is injected at build time via
// the NEAR_1CLICK_JWT define (webpack DefinePlugin): GitHub Actions provides it
// from the NEAR_1CLICK_JWT repo secret during release builds; local webpack
// builds read apps/extension/.env.local (gitignored). Empty => unauthenticated
// 1Click request (degrades the fee-free partner path only).
const AUTH_TOKEN = process.env['NEAR_1CLICK_JWT'] ?? '';

// ── types ──

export interface NearToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number | null;
}

export interface SwapQuoteRequest {
  dry?: boolean;
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  slippageTolerance: number; // percentage * 100 (e.g. 200 = 2%)
  originAsset: string;
  depositType: 'ORIGIN_CHAIN';
  destinationAsset: string;
  amount: string; // base units
  refundTo: string;
  refundType: 'ORIGIN_CHAIN';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string; // ISO 8601
  quoteWaitingTimeMs?: number;
  appFees?: { recipient: string; fee: number }[];
  referral?: string;
}

export interface SwapQuoteResponse {
  timestamp: string;
  quoteRequest: SwapQuoteRequest;
  quote: {
    // present on a real quote; a dry (estimate) quote returns "" here since no
    // deposit address is issued. Callers must only read it on real quotes.
    depositAddress: string;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    minAmountIn?: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    // guaranteed floor after slippage - what the recipient is assured to get
    minAmountOut?: string;
    // seconds the route is expected to take end-to-end
    timeEstimate?: number;
    // destination-chain withdrawal (network) fee, in destination base units
    withdrawFee?: string;
    // fee charged only if the swap has to refund, in origin base units
    refundFee?: string;
    deadline?: string;
  };
}

export type SwapStatus =
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED';

export interface SwapStatusResponse {
  quoteResponse: SwapQuoteResponse;
  status: SwapStatus | null;
  updatedAt: string;
  swapDetails?: {
    amountIn?: string;
    amountInFormatted?: string;
    amountInUsd?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    amountOutUsd?: string;
    slippage?: number;
  };
}

// ── API calls ──

async function nearFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // asks before the first request; declining still reaches fetch, which the
  // egress guard refuses with a named EgressBlockedError for the caller to show
  await requestEgressOptIn('near-swap');
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // docs require `Authorization: Bearer <JWT>`; a bare token is not
      // recognized (and the 0.2% fee waiver only applies with the Bearer form)
      Authorization: `Bearer ${AUTH_TOKEN}`,
      ...init?.headers,
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    let msg = `NEAR API ${resp.status}`;
    try {
      const err = JSON.parse(body);
      if (err.message) {
        msg = err.message;
      }
    } catch {
      /* use default */
    }
    throw new Error(msg);
  }

  return resp.json() as Promise<T>;
}

/** Fetch supported tokens for crosschain swaps. */
export async function getSupportedTokens(): Promise<NearToken[]> {
  return nearFetch<NearToken[]>('/v0/tokens');
}

/** Request a swap quote. Returns deposit address + amounts. */
export async function requestQuote(params: {
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT';
  amount: string; // base units
  originAsset: string;
  destinationAsset: string;
  recipient: string;
  refundTo: string;
  slippageTolerance?: number; // percentage * 100, default 200 (2%)
  // dry: price/fee estimate only - no deposit address is issued, so no funds
  // can move. Used to quote before the user has entered a real address. A
  // VALID destination-chain recipient is still required (the API validates it
  // even when dry), so callers pass a placeholder for the estimate.
  dry?: boolean;
  /** zafu's app fee in bps, taken from the amount out; 0 = none */
  appFeeBps?: number;
  signal?: AbortSignal;
}): Promise<SwapQuoteResponse> {
  const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const request: SwapQuoteRequest = {
    dry: params.dry ?? false,
    swapType: params.swapType,
    slippageTolerance: params.slippageTolerance ?? 200,
    originAsset: params.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: params.destinationAsset,
    amount: params.amount,
    refundTo: params.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: params.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline,
    quoteWaitingTimeMs: 3000,
    appFees: params.appFeeBps
      ? [{ recipient: NEAR_APP_FEE_RECIPIENT, fee: params.appFeeBps }]
      : undefined,
    referral: 'zafu',
  };

  return nearFetch<SwapQuoteResponse>('/v0/quote', {
    method: 'POST',
    body: JSON.stringify(request),
    signal: params.signal,
  });
}

/** Check swap status by deposit address. */
export async function checkSwapStatus(depositAddress: string): Promise<SwapStatusResponse> {
  return nearFetch<SwapStatusResponse>(
    `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
  );
}

/** Submit deposit transaction hash to speed up detection. */
export async function submitDepositTx(txHash: string, depositAddress: string): Promise<void> {
  await nearFetch('/v0/deposit/submit', {
    method: 'POST',
    body: JSON.stringify({ txHash, depositAddress }),
  });
}

// ── helpers ──

/** Find the best ZEC asset ID from the token list (prefers 'zec' blockchain). */
export function findZecAssetId(tokens: NearToken[]): string | undefined {
  const zecTokens = tokens.filter(t => t.symbol === 'ZEC');
  return (zecTokens.find(t => t.blockchain === 'zec') ?? zecTokens[0])?.assetId;
}

/**
 * Every token swappable with ZEC, on every chain 1Click lists it on (the picker
 * goes chain first). ZEC is dropped: it is always the local side. Each symbol's
 * native chain comes first, then well-supported chains, so a link that names
 * only a symbol ("btc") lands on bitcoin, not a wrapped variant on aptos.
 */
const CHAIN_PREFERENCE = ['btc', 'eth', 'sol', 'near', 'arb', 'base', 'pol'];
const chainRank = (t: NearToken): number => {
  if (t.blockchain === t.symbol.toLowerCase()) {
    return -1;
  }
  const i = CHAIN_PREFERENCE.indexOf(t.blockchain);
  return i >= 0 ? i : CHAIN_PREFERENCE.length;
};
export function filterSwappableTokens(tokens: NearToken[]): NearToken[] {
  return tokens.filter(t => t.symbol !== 'ZEC').sort((a, b) => chainRank(a) - chainRank(b));
}
