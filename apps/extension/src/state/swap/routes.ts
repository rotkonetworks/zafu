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
 * for source chain"). Paying from an exchange there sends a refund to the
 * exchange.
 */
export const refundsToPayer = (route: RouteId | undefined, pair: SwapPair): boolean =>
  pair.direction === 'into_zec' &&
  route === 'thor' &&
  poolAsset('thor', pair)?.carrier === 'op_return';

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
  /** someone holds the funds in flight: the first swap through it is acknowledged once */
  custodial?: true;
  /** undefined when the route can carry the pair, else why not */
  refuses: (pair: SwapPair) => string | undefined;
}

export const ROUTES: Record<RouteId, RouteMeta> = {
  near: {
    label: 'near intents',
    egress: 'near-swap',
    custody: 'a solver holds funds briefly',
    custodial: true,
    refuses: () => undefined,
  },
  thor: {
    label: 'thorchain',
    egress: 'thorchain',
    // its vaults are threshold-signed by the node set: no one holds them, many do
    custody: "no single custodian · thorchain's nodes hold the vault",
    refuses: nodeRefuses('thor', 'thorchain'),
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

/** the first swap through a custodial route is acknowledged; a non-custodial one never asks */
export const asksCustody = (route: RouteId, acked: readonly RouteId[]): boolean =>
  !!ROUTES[route].custodial && !acked.includes(route);

/**
 * Stored route choices, kept only where they name a route zafu still has:
 * old storage and backups may name one since removed (maya).
 */
export const knownRoutes = (stored: Record<string, string> | undefined): Record<string, RouteId> =>
  Object.fromEntries(Object.entries(stored ?? {}).filter(([, r]) => isRouteId(r))) as Record<
    string,
    RouteId
  >;
