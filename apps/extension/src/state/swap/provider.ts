/**
 * One swap route as a service: tokens -> quote -> status. Every route returns
 * the same Quote shape, so the screen compares and shows them without knowing
 * which is which, and adding a route is a new implementation, not a branch.
 */

import type { RouteId, SwapPair } from './routes';

/** a token the other side of the swap can be */
export interface SwapToken {
  /** uppercase, as shown */
  symbol: string;
  /** lowercase, near's chain naming */
  chain: string;
  decimals: number;
}

export interface QuoteRequest {
  direction: SwapPair['direction'];
  token: SwapToken;
  /** decimal, in the asset being sent */
  amountIn: string;
  /** this wallet's shielded receive address */
  zcashAddress: string;
  /** this pocket's transparent address, for routes that pay only those */
  zcashTransparent?: string;
  /** into zec: the payer's refund address; from zec: where the token goes */
  otherAddress: string;
  /** this wallet signs a t->t with an OP_RETURN (CAPS.opReturn) */
  signsOpReturn?: boolean;
}

export interface Quote {
  route: RouteId;
  /** destination base units, after every fee the route takes */
  amountOut: bigint;
  /** display, in the destination asset */
  amountOutText: string;
  /** display, in the source asset */
  amountInText: string;
  feeText?: string;
  timeText?: string;
  /** ms epoch */
  expiresAt?: number;
  /** where the source asset goes */
  depositAddress: string;
  /** must travel with the deposit, exactly as given */
  memo?: string;
  /** where the destination asset lands */
  recipient: string;
  /** set when the route can quote this but zafu can't send it yet */
  notYet?: string;
  /** how the swap is watched: by its deposit address, by the deposit's txid, or not at all */
  watch?: 'deposit' | 'txid';
  raw: unknown;
}

export type SwapPhase = 'waiting' | 'processing' | 'done' | 'failed';

export interface SwapStatusView {
  phase: SwapPhase;
  line: string;
}

export interface SwapProvider {
  id: RouteId;
  /** what the token picker offers; may ask for this route's egress */
  tokens: () => Promise<SwapToken[]>;
  quote: (req: QuoteRequest) => Promise<Quote>;
  /** absent when the route can't be watched from here; `txid` for `watch: 'txid'` quotes */
  status?: (quote: Quote, txid?: string) => Promise<SwapStatusView>;
}

/** base units for a decimal string, exact (no float) */
export const toUnits = (text: string, decimals: number): bigint => {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) {
    return 0n;
  }
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt((m[1] || '0') + frac);
};

/** decimal string for base units, trailing zeros trimmed */
export const fromUnits = (units: bigint, decimals: number, places = 8): string => {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals, s.length - decimals + places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};

/** units in one fixed-point scale -> another */
export const rescale = (units: bigint, from: number, to: number): bigint =>
  to >= from ? units * 10n ** BigInt(to - from) : units / 10n ** BigInt(from - to);

/** sendable first, then most out after fees; the head is the best route */
export const rank = (quotes: readonly Quote[]): Quote[] =>
  [...quotes].sort((a, b) =>
    !!a.notYet !== !!b.notYet
      ? a.notYet
        ? 1
        : -1
      : Number(b.amountOut > a.amountOut) - Number(a.amountOut > b.amountOut),
  );
