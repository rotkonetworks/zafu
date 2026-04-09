/**
 * NEAR 1Click crosschain swap API client
 *
 * Uses ChainDefuser's 1Click API (same as Zashi mobile) for
 * crosschain swaps to/from ZEC. The API handles routing through
 * NEAR's intent infrastructure — we just request quotes and send
 * ZEC to the deposit address.
 *
 * Flow:
 *   1. GET /v0/tokens — list supported assets
 *   2. POST /v0/quote — get quote with deposit address
 *   3. User sends ZEC to deposit address (or receives at their address)
 *   4. GET /v0/status?depositAddress=... — poll for completion
 */

const API_BASE = 'https://1click.chaindefuser.com';

// same JWT as Zashi — partner_id: electriccoin
const AUTH_TOKEN =
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjIwMjUtMDQtMjMtdjEifQ.eyJ2IjoxLCJrZXlfdHlwZSI6ImRpc3RyaWJ1dGlvbl9jaGFubmVsIiwicGFydG5lcl9pZCI6ImVsZWN0cmljY29pbiIsImlhdCI6MTc1NTE5MDc0MywiZXhwIjoxNzg2NzI2NzQzfQ.LHhSp459njnOoyCssprT4Rc-J4TqlPo6qCcKy0A5npuc3A5iHl-zZ-qua_XroN9ZmU8HxeE4y0qVDeBMQgrzwdV3EybkfXTuSaHI8D4BwbAvkZgYMGqdlCpVFMU4g1uWZSZr2jZiQMkaGm5FxkLsO9bf1g38v-IkT6pEgLYM37kd5K5j4vEv2OC8Qs0dOCPvrnbP_t83ef4ldvJ7fDYlN9faLudHx-BU_FV5vMgMab8yZE_mpYtRNFRAKcSFgIqHlcUdxFZ_nM7yvt6aXoVHbiO9Z8XwhN24ADjnaDtNJ-Jp_z9NqRTxwsNQK2ToszrwNqTMqf86_TuXfl7otZAQMw';

const AFFILIATE_ADDRESS = 'd78abd5477432c9d9c5e32c4a1a0056cd7b8be6580d3c49e1f97185b786592db';
const AFFILIATE_FEE_BPS = 67;

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
  appFees: Array<{ recipient: string; fee: number }>;
  referral?: string;
}

export interface SwapQuoteResponse {
  timestamp: string;
  quoteRequest: SwapQuoteRequest;
  quote: {
    depositAddress: string;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    deadline: string;
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
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: AUTH_TOKEN,
      ...init?.headers,
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    let msg = `NEAR API ${resp.status}`;
    try {
      const err = JSON.parse(body);
      if (err.message) msg = err.message;
    } catch { /* use default */ }
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
}): Promise<SwapQuoteResponse> {
  const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const request: SwapQuoteRequest = {
    dry: false,
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
    appFees: [{ recipient: AFFILIATE_ADDRESS, fee: AFFILIATE_FEE_BPS }],
    referral: 'zodl',
  };

  return nearFetch<SwapQuoteResponse>('/v0/quote', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

/** Check swap status by deposit address. */
export async function checkSwapStatus(depositAddress: string): Promise<SwapStatusResponse> {
  return nearFetch<SwapStatusResponse>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
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

/** Filter tokens to only those swappable with ZEC (exclude ZEC variants). */
export function filterSwappableTokens(tokens: NearToken[]): NearToken[] {
  return tokens.filter(t => t.symbol !== 'ZEC');
}

/** Format amount from base units to display (e.g. zatoshis → ZEC). */
export function formatAmount(baseUnits: string, decimals: number): string {
  const n = Number(baseUnits);
  if (isNaN(n)) return '0';
  return (n / 10 ** decimals).toFixed(Math.min(decimals, 8));
}

/** Convert display amount to base units string. */
export function toBaseUnits(displayAmount: string, decimals: number): string {
  const n = parseFloat(displayAmount);
  if (isNaN(n) || n <= 0) return '0';
  return Math.floor(n * 10 ** decimals).toString();
}

/** Map NEAR 1Click blockchain name to our ContactNetwork type. */
const BLOCKCHAIN_TO_NETWORK: Record<string, string> = {
  ethereum: 'ethereum',
  bitcoin: 'bitcoin',
  solana: 'solana',
  near: 'near',
  base: 'base',
  arbitrum: 'arbitrum',
  avalanche: 'avalanche',
  polygon: 'polygon',
};

export function blockchainToContactNetwork(blockchain: string): string | undefined {
  return BLOCKCHAIN_TO_NETWORK[blockchain.toLowerCase()];
}
