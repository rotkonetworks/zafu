/** the swap routes wired together; the screen's live prices are in ./live */

import { nearProvider } from './near';
import { thorProvider } from './thor';
import type { SwapProvider, SwapToken } from './provider';
import type { RouteId } from './routes';

/** penumbra quotes no zec pair, so it has no implementation here; its dex has its own screen */
export const PROVIDERS: Partial<Record<RouteId, SwapProvider>> = {
  near: nearProvider,
  thor: thorProvider,
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
