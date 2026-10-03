/**
 * One route's quote, completed against the market: the source chain's
 * network fee when zafu sends it, what arrives against what is paid at
 * market prices (1click's list), and the price gap beyond the listed fees as
 * its own part. A route with no exact-output mode is quoted by what arrives
 * through probes. Market prices are read only when 1click may be asked, and
 * are never guessed.
 */

import { readEgressView } from '../../net/egress-opt-in';
import { nearPrices } from './near';
import {
  costOf,
  fromUnits,
  toUnits,
  type Quote,
  type QuoteRequest,
  type SwapProvider,
} from './provider';
import { ROUTES } from './routes';

/** usd per whole unit, of what is paid and what arrives */
export interface Market {
  pIn: number;
  pOut: number;
}

const decimalsOf = (req: QuoteRequest): [number, number] =>
  req.direction === 'from_zec' ? [8, req.token.decimals] : [req.token.decimals, 8];

/** the pair's market prices, from 1click's list once near-swap may be asked; else none */
export const marketOf = async (req: QuoteRequest): Promise<Market | undefined> => {
  if (!(await readEgressView()).find(d => d.id === ROUTES.near.egress)?.on) {
    return undefined;
  }
  const prices = await nearPrices();
  const zec = prices.get('ZEC@zec');
  const token = prices.get(`${req.token.symbol}@${req.token.chain}`);
  if (!zec || !token) {
    return undefined;
  }
  return req.direction === 'from_zec' ? { pIn: zec, pOut: token } : { pIn: token, pOut: zec };
};

const worth = (units: bigint, decimals: number, usd: number) =>
  (Number(units) / 10 ** decimals) * usd;

/**
 * The quote with the source fee (out of zec, paid by zafu's own send) as a
 * cost part, its standing against the market in bps, and any price gap past
 * its listed fees as a part of its own.
 */
export const priced = (q: Quote, req: QuoteRequest, market?: Market): Quote => {
  const [inDecimals, outDecimals] = decimalsOf(req);
  const paid = toUnits(q.amountInText, inDecimals);
  const fee = req.direction === 'from_zec' ? BigInt(q.sourceFeeZat ?? req.sourceFeeZat ?? 0) : 0n;
  const parts = [...(q.cost?.parts ?? [])];
  if (fee && paid) {
    parts.unshift({
      label: 'network fee out',
      bps: Number((fee * 10_000n) / paid),
      out: (fee * q.amountOut) / paid,
      inText: `~${fromUnits(fee, 8)} zec${q.sourceFeeNote ? ` · ${q.sourceFeeNote}` : ''}`,
    });
  }
  if (!market || !paid) {
    return { ...q, cost: parts.length ? costOf(parts) : q.cost };
  }
  const spent = worth(paid + fee, inDecimals, market.pIn);
  const vsMarketBps = Math.round(
    ((worth(q.amountOut, outDecimals, market.pOut) - spent) / spent) * 10_000,
  );
  const listed = parts.reduce((n, p) => n + p.bps, 0);
  const gap = -vsMarketBps - listed;
  if (gap > 0) {
    // the market value lost beyond the listed fees, in the asset that arrives
    const lost = spent / market.pOut - Number(q.amountOut) / 10 ** outDecimals;
    const out = BigInt(Math.max(0, Math.round(lost * 10 ** outDecimals))) - costOf(parts).out;
    // the market is near intents' own price list: the line says whose prices it is measured by
    parts.push({ label: "vs near's price list", bps: gap, out: out > 0n ? out : 0n });
  }
  return { ...q, cost: costOf(parts), vsMarketBps };
};

/**
 * A route with no exact-output mode, quoted by what arrives: a first input
 * from the market (or the other field's figure), then refined in proportion
 * until it lands within 0.5% of what is wanted, at most three asks. Said
 * "about"; if it doesn't settle, the route quotes by what you pay.
 */
export const invert = async (
  provider: SwapProvider,
  req: QuoteRequest,
  market: Market | undefined,
  signal?: AbortSignal,
): Promise<Quote> => {
  const [inDecimals, outDecimals] = decimalsOf(req);
  const want = toUnits(req.exactOut!, outDecimals);
  let paying = market
    ? toUnits(((Number(req.exactOut) * market.pOut) / market.pIn).toFixed(inDecimals), inDecimals)
    : toUnits(req.amountIn, inDecimals);
  for (let ask = 0; ask < 3 && paying > 0n && want > 0n; ask++) {
    const q = await provider.quote(
      { ...req, amountIn: fromUnits(paying, inDecimals, inDecimals), exactOut: undefined },
      signal,
    );
    const off = q.amountOut > want ? q.amountOut - want : want - q.amountOut;
    if (off * 200n <= want) {
      return { ...q, approx: true };
    }
    if (!q.amountOut) {
      break;
    }
    paying = (paying * want + q.amountOut - 1n) / q.amountOut;
  }
  throw new Error(`${ROUTES[provider.id].label} quotes by what you pay`);
};

/** one route's quote as the screen shows it: by what is paid or what arrives, against the market */
export const quoteRoute = async (
  provider: SwapProvider,
  req: QuoteRequest,
  signal?: AbortSignal,
): Promise<Quote> => {
  // the market is read beside the quote, never in front of it (an inversion needs it first)
  const market = marketOf(req).catch(() => undefined);
  const [q, m] = await Promise.all([
    req.exactOut && !provider.exactOut
      ? market.then(m => invert(provider, req, m, signal))
      : provider.quote(req, signal),
    market,
  ]);
  return priced(q, req, m);
};
