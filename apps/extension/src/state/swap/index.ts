/** the swap routes wired together: ask each route's egress once, then quote them side by side */

import { requestEgressOptIn } from '../../net/egress-opt-in';
import { nearProvider } from './near';
import { thorProvider } from './thor';
import { mayaProvider } from './maya';
import { rank, type Quote, type QuoteRequest, type SwapProvider, type SwapToken } from './provider';
import { ROUTES, type RouteId } from './routes';

/** penumbra quotes no zec pair, so it has no implementation here; its dex has its own screen */
export const PROVIDERS: Partial<Record<RouteId, SwapProvider>> = {
  near: nearProvider,
  thor: thorProvider,
  maya: mayaProvider,
};

export type RouteResult = { route: RouteId; quote: Quote } | { route: RouteId; error: unknown };

/**
 * Ask each route's destination in turn (one sheet at a time), then quote every
 * route the user allowed at once. A route the user declined is left out; one
 * that fails keeps its error for its row. Ranked best first.
 */
export const quoteRoutes = async (ids: RouteId[], req: QuoteRequest): Promise<RouteResult[]> => {
  const allowed: SwapProvider[] = [];
  for (const id of ids) {
    const p = PROVIDERS[id];
    if (p && (await requestEgressOptIn(ROUTES[id].egress))) {
      allowed.push(p);
    }
  }
  const settled = await Promise.allSettled(allowed.map(p => p.quote(req)));
  const quotes = rank(settled.flatMap(s => (s.status === 'fulfilled' ? [s.value] : [])));
  return [
    ...quotes.map(quote => ({ route: quote.route, quote })),
    ...settled.flatMap((s, i) =>
      s.status === 'rejected' ? [{ route: allowed[i]!.id, error: s.reason as unknown }] : [],
    ),
  ];
};

/** the picker's tokens across routes, one per symbol and chain, near's first */
export const routeTokens = async (ids: RouteId[]): Promise<SwapToken[]> => {
  const lists = await Promise.allSettled(ids.map(id => PROVIDERS[id]?.tokens() ?? []));
  const failed = lists.find(l => l.status === 'rejected');
  if (failed && lists.every(l => l.status === 'rejected')) {
    throw failed.reason;
  }
  const seen = new Set<string>();
  return lists
    .flatMap(l => (l.status === 'fulfilled' ? l.value : []))
    .filter(t => !seen.has(`${t.symbol}@${t.chain}`) && !!seen.add(`${t.symbol}@${t.chain}`));
};
