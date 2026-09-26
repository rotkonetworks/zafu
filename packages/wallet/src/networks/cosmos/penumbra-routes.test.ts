import { describe, expect, it } from 'vitest';
import { selectPenumbraRoute, type PenumbraRoute } from './penumbra-routes';

const r = (chainId: string, src: number, dst: number, active: boolean): PenumbraRoute => ({
  chainId,
  penumbraSourceChannel: `channel-${src}`,
  penumbraChannel: `channel-${dst}`,
  active,
});

// the live picture on 2026-09-27: cosmoshub's old pair expired, a new one active
const routes = [
  r('cosmoshub-4', 0, 940, false),
  r('cosmoshub-4', 22, 1934, true),
  r('osmosis-1', 4, 79703, false),
  r('osmosis-1', 20, 111093, true),
  r('osmosis-1', 19, 111092, true),
  r('celestia', 3, 35, false),
];

describe('selectPenumbraRoute', () => {
  it('never returns a pinned channel whose client has expired', () => {
    expect(selectPenumbraRoute(routes, 'cosmoshub-4', 'channel-0')?.penumbraSourceChannel).toBe(
      'channel-22',
    );
  });

  it('keeps the pinned channel when it is active', () => {
    expect(selectPenumbraRoute(routes, 'osmosis-1', 'channel-20')?.penumbraSourceChannel).toBe(
      'channel-20',
    );
  });

  it('picks the lowest-numbered active channel when nothing is pinned', () => {
    const route = selectPenumbraRoute(routes, 'osmosis-1');
    expect(route?.penumbraSourceChannel).toBe('channel-19');
    expect(route?.penumbraChannel).toBe('channel-111092');
  });

  it('has no route when every channel to the chain is expired', () => {
    expect(selectPenumbraRoute(routes, 'celestia', 'channel-3')).toBeUndefined();
    expect(selectPenumbraRoute(routes, 'axelar-dojo-1')).toBeUndefined();
  });
});
