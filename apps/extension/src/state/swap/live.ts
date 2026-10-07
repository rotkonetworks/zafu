/**
 * The swap screen's live prices, as data: which routes a pair may ask, one
 * query per route (a dry price, cancelled once its inputs move on, refreshed
 * only while the screen is seen), the amounts the form opens with, and the
 * pair it reopens on. The swap buttons' warm start is ./preload.
 */

import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { localExtStorage } from '@repo/storage-chrome/local';
import { readEgressView } from '../../net/egress-opt-in';
import { isEgressBlocked } from '../../net/egress';
import { EGRESS_INPUT_KEYS, type DestinationView } from '../../net/egress-policy';
import { NEAR_QUOTE_WAIT_MS } from '../near-swap';
import { PROVIDERS } from '.';
import { quoteRoute } from './market';
import { fromUnits, toUnits, type Quote, type QuoteRequest, type SwapToken } from './provider';
import { ROUTE_IDS, ROUTES, type RouteId, type SwapPair } from './routes';

export const DEBOUNCE_MS = 400;

/** how long a route's answer really takes: its waiting line shows after `after` ms and fills over `over` */
export const WAIT: Partial<Record<RouteId, { after: number; over: number }>> = {
  near: { after: 0, over: NEAR_QUOTE_WAIT_MS },
  thor: { after: 300, over: 1_700 },
};

/** the header's one quiet line as answers come in: who is asked, who answered, how many to choose from */
export const quoteStatus = (
  routes: readonly { route: RouteId; out: boolean; priced: boolean }[],
): string | undefined => {
  const short = (r: { route: RouteId }) => ROUTES[r.route].label.split(' ')[0];
  const out = routes.filter(r => r.out);
  const priced = routes.filter(r => r.priced && !r.out);
  return out.length
    ? priced.length
      ? `${priced.map(short).join(', ')} answered`
      : `asking ${out.map(short).join(', ')}`
    : priced.length > 1
      ? `best of ${priced.length}`
      : priced[0] && `${short(priced[0])} answered`;
};
/** a seen price is asked again this often, and always before it expires */
export const REFRESH_MS = 30_000;
const LEAD_MS = 15_000;

/** the routes that have an implementation */
export const QUOTABLE = ROUTE_IDS.filter(id => PROVIDERS[id]);

/** everything a swap talks to: asked together, once, when the swap first opens */
export const SWAP_EGRESS = QUOTABLE.map(id => ROUTES[id].egress);

/** a route as the screen lists it: asked for a price, or one quiet line saying why not */
export interface Gate {
  route: RouteId;
  line?: string;
  /** not asked yet: a tap asks once */
  ask?: true;
}

/** a route's refusal as its row says it: plain words, without its own name */
export const plain = (route: RouteId, e: unknown): string => {
  const name = ROUTES[route].label;
  const text = isEgressBlocked(e)
    ? e.refusal.reason === 'transport-down'
      ? e.message
      : 'off in settings'
    : typeof e === 'string'
      ? e
      : (e instanceof Error && e.message) || 'could not quote this right now';
  return text.startsWith(`${name} `) ? text.slice(name.length + 1).replace(/^· /, '') : text;
};

/** every route for a pair: the ones allowed to be asked, the rest with their line */
export const gates = (
  pair: SwapPair,
  views: readonly DestinationView[],
  pinned?: RouteId,
): Gate[] =>
  (pinned ? [pinned] : QUOTABLE).map(route => {
    const refused = ROUTES[route].refuses(pair);
    const view = views.find(d => d.id === ROUTES[route].egress);
    return refused
      ? { route, line: plain(route, refused) }
      : view?.on
        ? { route }
        : view?.why === 'default-off'
          ? { route, line: 'ask for a price', ask: true }
          : { route, line: 'off in settings' };
  });

export const pairOf = ({ direction, token }: Pick<QuoteRequest, 'direction' | 'token'>) => ({
  direction,
  symbol: token.symbol.toLowerCase(),
  chain: token.chain,
});

/** ms to the next ask: the refresh, or just before the price expires; never for no price */
export const refreshIn = (quote: Quote | undefined, at: number, now = Date.now()): number | false =>
  !!quote &&
  Math.max(1_000, Math.min(at + REFRESH_MS, (quote.expiresAt ?? Infinity) - LEAD_MS) - now);

export const egressViewQuery = queryOptions({
  queryKey: ['egress-view'],
  queryFn: () => readEgressView(),
});

/** a destination allowed or blocked anywhere (an ask sheet, settings) is seen here at once */
export const watchEgress = (client: QueryClient): (() => void) => {
  const changed = (c: Record<string, unknown>, area: string) => {
    if (area === 'local' && EGRESS_INPUT_KEYS.some(k => k in c)) {
      void client.invalidateQueries({ queryKey: egressViewQuery.queryKey });
    }
  };
  chrome.storage.onChanged.addListener(changed);
  return () => chrome.storage.onChanged.removeListener(changed);
};

/**
 * One route's dry price. The shielded address stays out of the key: it is
 * fresh each time it is shown, and any of them is this wallet's.
 */
export const quoteQuery = (route: RouteId, wallet: string, req: QuoteRequest) => {
  const queryKey = [
    'swap-quote',
    wallet,
    route,
    req.direction,
    req.token.symbol,
    req.token.chain,
    // by what arrives, the paid figure is only a hint (exact output: kept for the unified screen)
    req.exactOut ? `out:${req.exactOut}` : req.amountIn,
    req.otherAddress,
    !!req.zcashTransparent,
    !!req.signsOpReturn,
  ];
  return queryOptions({
    queryKey,
    queryFn: ({ signal }) => quoteRoute(PROVIDERS[route]!, { ...req, dry: true }, signal),
    retry: false,
    staleTime: REFRESH_MS,
    // seen again: a stale price is asked at once; hidden, the refresh waits
    refetchOnWindowFocus: true,
    refetchInterval: q => refreshIn(q.state.data, q.state.dataUpdatedAt),
  });
};

/** the newest price of the same pair and route: shown, dimmed, while the next is asked */
export const lastOfPair = (client: QueryClient, queryKey: readonly unknown[]): Quote | undefined =>
  client
    .getQueryCache()
    .findAll({ queryKey: queryKey.slice(0, 6) })
    .filter(q => q.state.data)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0]?.state.data as
    | Quote
    | undefined;

/** two significant figures, rounded down: clean, and never more than it came from */
export const clean = (units: bigint): bigint => {
  const drop = 10n ** BigInt(Math.max(0, units.toString().length - 2));
  return (units / drop) * drop;
};

/** the quick amounts out of zec: clean shares of what can be sent, and max exactly */
export const chips = (maxZat: bigint): { label: string; amount: string }[] =>
  maxZat > 0n
    ? [
        ...[10, 25, 50].map(p => ({
          label: `${p}%`,
          amount: fromUnits(clean((maxZat * BigInt(p)) / 100n), 8),
        })),
        { label: 'max', amount: fromUnits(maxZat, 8) },
      ].filter(c => c.amount !== '0')
    : [];

/** what the form opens with: 10% of the zec out, about $100 of a priced token in, else nothing */
export const defaultAmount = (
  direction: SwapPair['direction'],
  maxZat: bigint,
  token?: SwapToken,
): string => {
  if (direction === 'from_zec') {
    return chips(maxZat).find(c => c.label === '10%')?.amount ?? '';
  }
  const units = token?.usd
    ? clean(toUnits((100 / token.usd).toFixed(token.decimals), token.decimals))
    : 0n;
  return units ? fromUnits(units, token!.decimals) : '';
};

/** the pair the screen reopens on, per wallet */
export interface SwapLast {
  direction: SwapPair['direction'];
  token?: SwapToken;
}

export const readLast = async (): Promise<Record<string, SwapLast>> =>
  (await localExtStorage.get('swapLast')) ?? {};

export const lastQuery = queryOptions({ queryKey: ['swapLast'], queryFn: readLast });

export const saveLast = async (wallet: string, last: SwapLast) =>
  localExtStorage.set('swapLast', { ...(await readLast()), [wallet]: last });
