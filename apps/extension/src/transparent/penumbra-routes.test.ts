import { describe, expect, it, vi } from 'vitest';
import { localExtStorage } from '@repo/storage-chrome/local';
import type { PenumbraRoute } from '@repo/wallet/networks/cosmos/penumbra-routes';
import {
  getPenumbraRoutes,
  offeredChains,
  penumbraRouteStatus,
  routeForChain,
} from './penumbra-routes';

const route = (
  chainId: string,
  penumbraSourceChannel: string,
  penumbraChannel: string,
  active: boolean,
): PenumbraRoute => ({ chainId, penumbraSourceChannel, penumbraChannel, active });

describe('offeredChains', () => {
  it('offers only the chains whose pinned pair is active, in order', () => {
    const routes = [
      route('celestia', 'channel-23', 'channel-701', false),
      route('osmosis-1', 'channel-20', 'channel-111093', true),
      route('axelar-dojo-1', 'channel-24', 'channel-198', true),
    ];
    expect(offeredChains(['celestia', 'axelar', 'osmosis'], routes)).toEqual(['axelar', 'osmosis']);
  });

  it('a chain whose pinned pair expired is not offered, whatever else claims it', () => {
    const routes = [
      route('cosmoshub-4', 'channel-22', 'channel-1934', false),
      route('cosmoshub-4', 'channel-0', 'channel-940', true),
    ];
    expect(offeredChains(['cosmoshub'], routes)).toEqual([]);
  });

  it('falls back to the pinned channels before discovery has run', () => {
    expect(offeredChains(['noble', 'axelar', 'kava'], undefined)).toEqual([
      'noble',
      'axelar',
      'kava',
    ]);
  });
});

describe('penumbraRouteStatus', () => {
  it('an expired pin is refused, not swapped for a channel that claims the chain', () => {
    const routes = [
      route('injective-1', 'channel-18', 'channel-494', false),
      route('injective-1', 'channel-99', 'channel-7', true),
    ];
    expect(penumbraRouteStatus('injective', routes)).toEqual({ status: 'inactive' });
    expect(routeForChain('injective', routes)).toBeUndefined();
  });

  it('the pair always comes from the registry, never from the node', () => {
    const routes = [route('injective-1', 'channel-18', 'channel-494', true)];
    expect(routeForChain('injective', routes)).toEqual({
      penumbraSourceChannel: 'channel-18',
      penumbraChannel: 'channel-494',
    });
  });
});

describe('getPenumbraRoutes while a testnet is in use', () => {
  it('asks no node and offers no ibc chain: they all reach mainnet', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await localExtStorage.set('enabledNetworks', ['penumbra', 'penumbra-testnet']);
    const routes = await getPenumbraRoutes();
    expect(routes).toEqual([]);
    expect(offeredChains(['noble', 'osmosis'], routes)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
