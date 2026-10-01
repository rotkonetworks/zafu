/**
 * The swap routes zafu knows, as data: who they are, which egress destination
 * each asks for, the one custody line, and which pairs each can carry. Pure
 * and tiny, so the link router can refuse an impossible `xc=` before any
 * screen opens.
 */

export const ROUTE_IDS = ['near', 'thor', 'penumbra'] as const;
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

/** how a deposit into thorchain carries its memo on the source chain */
export type MemoCarrier = 'op_return' | 'memo';

/** thorchain pools zafu offers, keyed `symbol@chain` */
export const THOR_ASSETS: Record<
  string,
  { asset: string; decimals: number; carrier?: MemoCarrier }
> = {
  'btc@btc': { asset: 'BTC.BTC', decimals: 8, carrier: 'op_return' },
  'ltc@ltc': { asset: 'LTC.LTC', decimals: 8, carrier: 'op_return' },
  'bch@bch': { asset: 'BCH.BCH', decimals: 8, carrier: 'op_return' },
  'doge@doge': { asset: 'DOGE.DOGE', decimals: 8, carrier: 'op_return' },
  'atom@gaia': { asset: 'GAIA.ATOM', decimals: 6, carrier: 'memo' },
  'xrp@xrp': { asset: 'XRP.XRP', decimals: 6, carrier: 'memo' },
  // evm deposits are a router contract call, which zafu can't hand to another wallet
  'eth@eth': { asset: 'ETH.ETH', decimals: 18 },
  'usdc@eth': { asset: 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48', decimals: 6 },
  'usdt@eth': { asset: 'ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7', decimals: 6 },
  'eth@base': { asset: 'BASE.ETH', decimals: 18 },
  'bnb@bsc': { asset: 'BSC.BNB', decimals: 18 },
  'avax@avax': { asset: 'AVAX.AVAX', decimals: 18 },
};

/** the thorchain pool for a pair; a bare symbol takes its native chain */
export const thorAsset = ({ symbol, chain }: SwapPair) =>
  THOR_ASSETS[`${symbol}@${chain ?? symbol}`] ??
  (chain ? undefined : Object.entries(THOR_ASSETS).find(([k]) => k.startsWith(`${symbol}@`))?.[1]);

export interface RouteMeta {
  label: string;
  egress: string;
  /** one line, shown with every quote from this route */
  custody: string;
  /** undefined when the route can carry the pair, else why not */
  refuses: (pair: SwapPair) => string | undefined;
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
    refuses: pair => {
      const a = thorAsset(pair);
      if (!a) {
        return `thorchain doesn't trade ${pair.symbol}${pair.chain ? ` on ${pair.chain}` : ''} · near intents may`;
      }
      if (pair.direction === 'into_zec' && !a.carrier) {
        return `thorchain needs a contract call for ${pair.symbol} · near intents can take this one`;
      }
      return undefined;
    },
  },
  penumbra: {
    label: 'penumbra',
    egress: 'penumbra',
    custody: 'shielded dex',
    // the dex trades penumbra assets only; its own swap screen carries those
    refuses: () => "penumbra's dex doesn't trade zec · thorchain or near intents can, if you like",
  },
};

/** the routes that may carry a pair: the pinned one, or every route that can */
export const candidates = (pair: SwapPair, pinned?: RouteId): RouteId[] =>
  pinned ? [pinned] : ROUTE_IDS.filter(id => !ROUTES[id].refuses(pair));
