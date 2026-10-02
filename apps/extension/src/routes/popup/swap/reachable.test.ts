import { describe, expect, it } from 'vitest';
import type { PenumbraRoute } from '@repo/wallet/networks/cosmos/penumbra-routes';
import { channelOf, reachOf, splitByReach } from './reachable';

const route = (chainId: string, ch: string, active: boolean): PenumbraRoute => ({
  chainId,
  penumbraSourceChannel: ch,
  penumbraChannel: 'channel-1',
  active,
});
const routes = [
  route('osmosis-1', 'channel-4', false),
  route('osmosis-1', 'channel-19', true),
  route('osmosis-1', 'channel-20', true),
];

describe('reachOf', () => {
  it('a native asset has no channel and is always reachable', () => {
    expect(channelOf('upenumbra')).toBeUndefined();
    expect(reachOf('upenumbra', routes)).toEqual({ reachable: true });
  });

  it('both live osmosis channels count, the expired one does not', () => {
    expect(reachOf('transfer/channel-19/uosmo', routes)).toEqual({
      reachable: true,
      via: 'osmosis-1',
    });
    expect(reachOf('transfer/channel-20/uosmo', routes).reachable).toBe(true);
    expect(reachOf('transfer/channel-4/uosmo', routes)).toEqual({
      reachable: false,
      via: 'channel 4',
    });
  });

  it('a channel penumbra does not report at all is closed', () => {
    expect(reachOf('transfer/channel-99/uatom', routes).reachable).toBe(false);
  });

  it('hides nothing before discovery has run', () => {
    expect(reachOf('transfer/channel-4/uosmo', undefined).reachable).toBe(true);
  });
});

describe('splitByReach', () => {
  it('never hides an asset you hold', () => {
    const assets = ['upenumbra', 'transfer/channel-4/uosmo', 'transfer/channel-0/uatom'];
    const held = new Set(['transfer/channel-0/uatom']);
    const { shown, hidden } = splitByReach(
      assets,
      a => a,
      a => held.has(a),
      routes,
    );
    expect(shown).toEqual(['upenumbra', 'transfer/channel-0/uatom']);
    expect(hidden).toEqual(['transfer/channel-4/uosmo']);
  });
});
