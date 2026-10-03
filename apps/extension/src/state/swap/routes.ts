/**
 * The swap routes zafu knows, as data: who they are, which egress destination
 * each asks for, the one custody line, and which pairs each can carry. Pure
 * and tiny, so the link router can refuse an impossible `xc=` before any
 * screen opens.
 */

import { MAYA_ENABLED } from '../../config/feature-flags';

export const ROUTE_IDS = ['near', 'thor', 'maya', 'penumbra'] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

export const isRouteId = (s: string): s is RouteId => (ROUTE_IDS as readonly string[]).includes(s);

/** a zec pair: the other side's symbol and chain, lowercase, chain in near's naming */
export interface SwapPair {
  direction: 'into_zec' | 'from_zec';
  symbol: string;
  chain?: string;
}

export const pairKey = ({ direction, symbol, chain }: SwapPair): string =>
  `${direction}:${symbol}${chain ? `@${chain}` : ''}`;

/** how a deposit carries its memo on the source chain */
export type MemoCarrier = 'op_return' | 'memo';

export interface PoolAsset {
  asset: string;
  decimals: number;
  /** absent for evm: a router contract call, which zafu can't hand to another wallet */
  carrier?: MemoCarrier;
}

/** the pools each THORNode-protocol route offers, keyed `symbol@chain` */
export const POOLS = {
  thor: {
    'btc@btc': { asset: 'BTC.BTC', decimals: 8, carrier: 'op_return' },
    'ltc@ltc': { asset: 'LTC.LTC', decimals: 8, carrier: 'op_return' },
    'bch@bch': { asset: 'BCH.BCH', decimals: 8, carrier: 'op_return' },
    'doge@doge': { asset: 'DOGE.DOGE', decimals: 8, carrier: 'op_return' },
    'atom@gaia': { asset: 'GAIA.ATOM', decimals: 6, carrier: 'memo' },
    'xrp@xrp': { asset: 'XRP.XRP', decimals: 6, carrier: 'memo' },
    'eth@eth': { asset: 'ETH.ETH', decimals: 18 },
    'usdc@eth': { asset: 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', decimals: 6 },
    'usdt@eth': { asset: 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7', decimals: 6 },
    'eth@base': { asset: 'BASE.ETH', decimals: 18 },
    'bnb@bsc': { asset: 'BSC.BNB', decimals: 18 },
    'avax@avax': { asset: 'AVAX.AVAX', decimals: 18 },
  },
  maya: {
    'btc@btc': { asset: 'BTC.BTC', decimals: 8, carrier: 'op_return' },
    'dash@dash': { asset: 'DASH.DASH', decimals: 8, carrier: 'op_return' },
    'rune@thor': { asset: 'THOR.RUNE', decimals: 8, carrier: 'memo' },
    'eth@eth': { asset: 'ETH.ETH', decimals: 18 },
    'usdc@eth': { asset: 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', decimals: 6 },
    'usdt@eth': { asset: 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7', decimals: 6 },
    'eth@arb': { asset: 'ARB.ETH', decimals: 18 },
    'usdc@arb': { asset: 'ARB.USDC-0XAF88D065E77C8CC2239327C5EDB3A432268E5831', decimals: 6 },
    'usdt@arb': { asset: 'ARB.USDT-0XFD086BC7CD5C481DCC9C85EBE478A1C0B69FCBB9', decimals: 6 },
  },
} satisfies Record<string, Record<string, PoolAsset>>;

/** a route's pool for a pair; a bare symbol takes its native chain */
export const poolAsset = (route: RouteId, { symbol, chain }: SwapPair): PoolAsset | undefined => {
  const pools: Record<string, PoolAsset> = POOLS[route as keyof typeof POOLS] ?? {};
  return (
    pools[`${symbol}@${chain ?? symbol}`] ??
    (chain ? undefined : Object.entries(pools).find(([k]) => k.startsWith(`${symbol}@`))?.[1])
  );
};

/**
 * Into zec, a route that refunds whoever paid instead of an address zafu
 * names: THORChain from a chain whose memo rides in an 80-byte OP_RETURN
 * (a refund address doesn't fit; THORNode answers "generated memo too long
 * for source chain"), and Maya always. Paying from an exchange there sends a
 * refund to the exchange.
 */
export const refundsToPayer = (route: RouteId | undefined, pair: SwapPair): boolean =>
  pair.direction === 'into_zec' &&
  (route === 'maya' || (route === 'thor' && poolAsset('thor', pair)?.carrier === 'op_return'));

/** why a THORNode-protocol route can't carry a pair, or undefined */
const nodeRefuses =
  (route: keyof typeof POOLS, name: string) =>
  (pair: SwapPair): string | undefined => {
    const a = poolAsset(route, pair);
    if (!a) {
      return `${name} doesn't trade ${pair.symbol}${pair.chain ? ` on ${pair.chain}` : ''} · near intents may`;
    }
    if (pair.direction === 'into_zec' && !a.carrier) {
      return `${name} needs a contract call for ${pair.symbol} · near intents can take this one`;
    }
    return undefined;
  };

export interface RouteMeta {
  label: string;
  egress: string;
  /** one line, shown with every quote from this route */
  custody: string;
  /** undefined when the route can carry the pair, else why not */
  refuses: (pair: SwapPair) => string | undefined;
  /** set while zafu doesn't offer the route at all: the one line a link to it gets */
  off?: string;
}

export const ROUTES: Record<RouteId, RouteMeta> = {
  near: {
    label: 'near intents',
    egress: 'near-swap',
    custody: 'a solver holds funds briefly',
    refuses: () => undefined,
  },
  thor: {
    label: 'thorchain',
    egress: 'thorchain',
    custody: 'no middleman',
    refuses: nodeRefuses('thor', 'thorchain'),
  },
  maya: {
    label: 'maya',
    egress: 'mayachain',
    custody: 'no middleman',
    refuses: nodeRefuses('maya', 'maya'),
    off: MAYA_ENABLED ? undefined : "maya isn't offered right now",
  },
  penumbra: {
    label: 'penumbra',
    egress: 'penumbra',
    custody: 'shielded dex',
    // the dex trades penumbra assets only; its own swap screen carries those
    refuses: () => "penumbra's dex doesn't trade zec · thorchain or near intents can, if you like",
  },
};

/** a route as the router names it: the best is said to be the best */
export const routeLabel = (id: RouteId, best: boolean): string =>
  best ? `best price · ${ROUTES[id].label}` : ROUTES[id].label;

/** the routes zafu offers at all */
export const OFFERED = ROUTE_IDS.filter(id => !ROUTES[id].off);
