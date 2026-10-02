import { describe, expect, it } from 'vitest';
import type { PenumbraRoute } from '@repo/wallet/networks/cosmos/penumbra-routes';
import { offeredChains } from './penumbra-routes';

const route = (chainId: string, penumbraSourceChannel: string, active: boolean): PenumbraRoute => ({
  chainId,
  penumbraSourceChannel,
  penumbraChannel: 'channel-1',
  active,
});

describe('offeredChains', () => {
  it('offers only the chains with an active route, in order', () => {
    const routes = [
      route('celestia', 'channel-3', false),
      route('osmosis-1', 'channel-20', true),
      route('axelar-dojo-1', 'channel-24', true),
    ];
    expect(offeredChains(['celestia', 'axelar', 'osmosis'], routes)).toEqual(['axelar', 'osmosis']);
  });

  it('a chain whose only channels expired is not offered', () => {
    expect(offeredChains(['cosmoshub'], [route('cosmoshub-4', 'channel-0', false)])).toEqual([]);
  });

  it('falls back to the pinned channels before discovery has run', () => {
    expect(offeredChains(['noble', 'axelar', 'kava'], undefined)).toEqual([
      'noble',
      'axelar',
      'kava',
    ]);
  });
});
