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
  /** a usd price from the route's list, when it gives one: only ever a default's hint */
  usd?: number;
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
  /** a price only: no deposit address is issued (1click's dry quote) */
  dry?: boolean;
  /**
   * decimal, in the asset received: quote by what arrives instead. `amountIn`
   * is then only a hint (the other field's last figure)
   */
  exactOut?: string;
  /** out of zec: the ZIP-317 fee of the shielded send to the deposit, in zat (a string: it is stored) */
  sourceFeeZat?: string;
}

/** one part of what a swap costs: a share of what is paid, and its worth in the destination asset */
export interface CostPart {
  label: string;
  bps: number;
  /** destination base units */
  out: bigint;
  /** said in the source asset instead, for a fee paid on the source chain */
  inText?: string;
  /** zafu's own fee, shown against the rate production charges */
  zafu?: true;
}

/** an estimate of everything a swap costs, each part listed */
export interface Cost {
  parts: CostPart[];
  bps: number;
  out: bigint;
}

export const costOf = (parts: CostPart[]): Cost => ({
  parts,
  bps: parts.reduce((n, p) => n + p.bps, 0),
  out: parts.reduce((n, p) => n + p.out, 0n),
});

/** a share in bps as a short percent: 62 -> 0.62%, 0 -> 0% */
export const pct = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

export interface Quote {
  route: RouteId;
  /** destination base units, after every fee the route takes */
  amountOut: bigint;
  /** display, in the destination asset */
  amountOutText: string;
  /** display, in the source asset */
  amountInText: string;
  /** the estimated cost, every fee the route and zafu take, and the source fee where known */
  cost?: Cost;
  /** what a refund would cost, when one is a real possibility */
  refundLine?: string;
  /** the fee rate to set when paying from another wallet */
  gasLine?: string;
  timeText?: string;
  /** the least the route may pay out (its signed price limit), display, in the destination asset */
  atLeastText?: string;
  /** one honest line when the swap streams for hours */
  streamLine?: string;
  /**
   * what arrives against what is paid, both at market prices from 1click's
   * list, in bps (negative is lost); absent when no market price is known
   */
  vsMarketBps?: number;
  /**
   * out of zec: what the sends on zafu's side cost in all, when the route
   * needs more than the one shielded send `QuoteRequest.sourceFeeZat` prices
   * (thorchain: the move to the swap's address, then the t->t deposit), zat
   */
  sourceFeeZat?: string;
  /** what that fee pays for, said after it */
  sourceFeeNote?: string;
  /** quoted by what arrives through probes (a route with no exact-output mode): "about" */
  approx?: true;
  /** ms epoch */
  expiresAt?: number;
  /** where the source asset goes; empty on a dry quote */
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

/** `refunded` is a calm end: the money is back, nothing failed */
export type SwapPhase = 'waiting' | 'processing' | 'done' | 'refunded' | 'failed';

export interface SwapStatusView {
  phase: SwapPhase;
  line: string;
}

export interface SwapProvider {
  id: RouteId;
  /** what the token picker offers; may ask for this route's egress */
  tokens: () => Promise<SwapToken[]>;
  quote: (req: QuoteRequest, signal?: AbortSignal) => Promise<Quote>;
  /** quotes `exactOut` itself; any other route is inverted by probes */
  exactOut?: true;
  /** absent when the route can't be watched from here; `txid` for `watch: 'txid'` quotes */
  status?: (quote: Quote, txid?: string) => Promise<SwapStatusView>;
}

/** how long a swap takes, said roughly: "~12 min", "about 24 h" */
export const durationText = (seconds: number): string =>
  seconds < 3600
    ? `~${Math.max(1, Math.round(seconds / 60))} min`
    : `about ${Math.round(seconds / 3600)} h`;

/**
 * An amount as shown: six significant figures (every whole digit kept),
 * rounded down so it never says more than arrives. Exact units stay inside.
 */
export const figure = (units: bigint, decimals: number, sig = 6): string => {
  const digits = units.toString().length;
  const cut = 10n ** BigInt(Math.max(0, digits - Math.max(sig, digits - decimals)));
  return fromUnits((units / cut) * cut, decimals, decimals);
};

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

/** how much more the best sendable route pays than the next, in destination base units */
export const lead = (ranked: readonly Quote[]): bigint | undefined => {
  const [best, next] = ranked.filter(q => !q.notYet);
  return best && next ? best.amountOut - next.amountOut : undefined;
};
