/**
 * Live Penumbra IBC routes for the transparent chains, cached.
 *
 * Discovery (packages/wallet penumbra-routes) asks the user's own Penumbra
 * endpoint which transfer channels have an Active client; the result is kept in
 * chrome.storage.local and refreshed at most hourly. Every place that needs a
 * chain's channel pair (receive, shield-in, withdraw) goes through
 * `routeForChain`. The pair always comes from the chain config (the bundled or
 * signed registry); discovery can only take it away once its client expires,
 * never offer another (see pinnedRouteStatus).
 *
 * Until the first discovery succeeds (fresh install, endpoint down) the pinned
 * pairs are used, as before.
 */

import { useEffect, useState } from 'react';
import {
  discoverPenumbraRoutes,
  pinnedRouteStatus,
  type PenumbraRoute,
} from '@repo/wallet/networks/cosmos/penumbra-routes';
import {
  chainByChainId,
  getCosmosChain,
  type CosmosChainId,
} from '@repo/wallet/networks/cosmos/chains';
import { resolvePenumbraEndpoint } from '../config/penumbra-endpoints';
import { forgetRegistryAssets, refreshRegistryAssets } from './assets';
import { fetchLiveRegistry, refreshForUnknownChains } from './registry-live';
import { REGISTRY_EGRESS } from './registry-endpoint';
import { requestEgressOptIn } from '../net/egress-opt-in';
import { refreshEgress } from '../net/egress';

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
 * A chain's way into Penumbra right now:
 * - 'active': the registry's pinned pair, with discovery reporting it Active
 *   (or discovery has never run, so nothing has shown it expired);
 * - 'inactive': the pinned pair is not Active, so nothing goes over it - and
 *   nothing goes over any other channel instead (see pinnedRouteStatus);
 * - 'none': the registry pins no pair for this chain.
 */
export type PenumbraRouteStatus =
  | { status: 'active'; route: ChainRoute }
  | { status: 'inactive' }
  | { status: 'none' };

export const penumbraRouteStatus = (
  chainId: CosmosChainId,
  routes: PenumbraRoute[] | undefined,
): PenumbraRouteStatus => {
  const cfg = getCosmosChain(chainId);
  if (!cfg.penumbraSourceChannel || !cfg.penumbraChannel) {
    return { status: 'none' };
  }
  const route = {
    penumbraSourceChannel: cfg.penumbraSourceChannel,
    penumbraChannel: cfg.penumbraChannel,
  };
  if (routes && pinnedRouteStatus(routes, route) !== 'active') {
    return { status: 'inactive' };
  }
  return { status: 'active', route };
};

/**
 * The route for one chain: always the registry's pinned pair, and only while
 * it is usable. Undefined when the pin is not Active or there is none.
 */
export const routeForChain = (
  chainId: CosmosChainId,
  routes: PenumbraRoute[] | undefined,
): ChainRoute | undefined => {
  const s = penumbraRouteStatus(chainId, routes);
  return s.status === 'active' ? s.route : undefined;
};

/**
 * The chains to offer, in the given order: those whose pinned pair is live, or
 * pinned at all while discovery has never run.
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
    void Promise.all([getPenumbraRoutes(), refreshRegistryAssets()]).then(async ([r]) => {
      if (alive) {
        setRoutes(r);
      }
      // a live channel to a chain zafu doesn't know: offer the signed registry
      const added = await refreshForUnknownChains(r ?? [], {
        known: chainId => !!chainByChainId(chainId),
        optIn: () => requestEgressOptIn(REGISTRY_EGRESS),
        fetch: fetchLiveRegistry,
      });
      if (added.length) {
        forgetRegistryAssets();
        await Promise.all([refreshEgress(), refreshRegistryAssets()]);
        if (alive) {
          setRoutes(r ? [...r] : r);
        }
      }
    });
    return () => {
      alive = false;
    };
  }, []);
  return routes;
};
