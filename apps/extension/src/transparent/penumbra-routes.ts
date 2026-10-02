/**
 * Live Penumbra IBC routes for the transparent chains, cached.
 *
 * Discovery (packages/wallet penumbra-routes) asks the user's own Penumbra
 * endpoint which transfer channels have an Active client; the result is kept in
 * chrome.storage.local and refreshed at most hourly. Every place that needs a
 * chain's channel pair (receive, shield-in, withdraw) goes through
 * `routeForChain`, so a stale pinned channel can't be used once discovery has
 * run.
 *
 * Until the first discovery succeeds (fresh install, endpoint down) the chain
 * config's pinned channels are used, as before.
 */

import { useEffect, useState } from 'react';
import {
  discoverPenumbraRoutes,
  selectPenumbraRoute,
  type PenumbraRoute,
} from '@repo/wallet/networks/cosmos/penumbra-routes';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { resolvePenumbraEndpoint } from '../config/penumbra-endpoints';
import { refreshRegistryAssets } from './assets';

const KEY = 'penumbraRoutes';
const MAX_AGE_MS = 60 * 60 * 1000;

interface Cached {
  endpoint: string;
  at: number;
  routes: PenumbraRoute[];
}

/** the channel pair to use for a chain; undefined = not reachable right now */
export interface ChainRoute {
  /** channel on Penumbra (penumbra -> chain) */
  penumbraSourceChannel: string;
  /** channel on the chain (chain -> penumbra) */
  penumbraChannel: string;
}

let inflight: Promise<PenumbraRoute[] | undefined> | undefined;

const readCache = async (): Promise<Cached | undefined> => {
  try {
    return (await chrome.storage.local.get(KEY))[KEY] as Cached | undefined;
  } catch {
    return undefined;
  }
};

/**
 * The discovered routes, refreshing when older than an hour or when the
 * Penumbra endpoint changed. Undefined when discovery has never succeeded.
 */
export const getPenumbraRoutes = async (): Promise<PenumbraRoute[] | undefined> => {
  const [cached, endpoint] = await Promise.all([readCache(), resolvePenumbraEndpoint()]);
  if (cached && cached.endpoint === endpoint && Date.now() - cached.at < MAX_AGE_MS) {
    return cached.routes;
  }
  inflight ??= discoverPenumbraRoutes(endpoint)
    .then(async routes => {
      await chrome.storage.local.set({ [KEY]: { endpoint, at: Date.now(), routes } });
      return routes;
    })
    .catch(err => {
      console.warn('[penumbra-routes] discovery failed, keeping the last known routes', err);
      return cached?.routes;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
};

/**
 * The route for one chain. With discovered routes: the live one (pin first),
 * or undefined if the chain has none. Without: the config's pinned pair.
 */
export const routeForChain = (
  chainId: CosmosChainId,
  routes: PenumbraRoute[] | undefined,
): ChainRoute | undefined => {
  const cfg = COSMOS_CHAINS[chainId];
  if (!routes) {
    return cfg.penumbraSourceChannel && cfg.penumbraChannel
      ? { penumbraSourceChannel: cfg.penumbraSourceChannel, penumbraChannel: cfg.penumbraChannel }
      : undefined;
  }
  return selectPenumbraRoute(routes, cfg.chainId, cfg.penumbraSourceChannel);
};

/**
 * The chains to offer, in the given order: those with a live route, or with
 * pinned channels while discovery has never run.
 */
export const offeredChains = (
  chains: readonly CosmosChainId[],
  routes: PenumbraRoute[] | undefined,
): CosmosChainId[] => chains.filter(c => routeForChain(c, routes));

/**
 * react hook: discovered routes (undefined until the first discovery lands).
 * Also waits for the live asset registry, so the re-render this triggers shows
 * the current labels for whatever the routes carry.
 */
export const usePenumbraRoutes = (): PenumbraRoute[] | undefined => {
  const [routes, setRoutes] = useState<PenumbraRoute[]>();
  useEffect(() => {
    let alive = true;
    void Promise.all([getPenumbraRoutes(), refreshRegistryAssets()]).then(([r]) => {
      if (alive) {
        setRoutes(r);
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return routes;
};
