import { describe, expect, it } from 'vitest';
import { pinnedRouteStatus, type PenumbraRoute } from './penumbra-routes';

const r = (chainId: string, src: number, dst: number, active: boolean): PenumbraRoute => ({
  chainId,
  penumbraSourceChannel: `channel-${src}`,
  penumbraChannel: `channel-${dst}`,
  active,
});
const pin = (src: number, dst: number) => ({
  penumbraSourceChannel: `channel-${src}`,
  penumbraChannel: `channel-${dst}`,
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

describe('pinnedRouteStatus', () => {
  it('the pinned pair is usable while its client is Active', () => {
    expect(pinnedRouteStatus(routes, pin(20, 111093))).toBe('active');
    expect(pinnedRouteStatus(routes, pin(22, 1934))).toBe('active');
  });

  it('an expired pin is refused, never swapped for another channel to the chain', () => {
    expect(pinnedRouteStatus(routes, pin(0, 940))).toBe('inactive');
    expect(pinnedRouteStatus(routes, pin(3, 35))).toBe('inactive');
  });

  it('a channel that only claims the chain id is never used', () => {
    // someone opened channel-99 to a chain of their own that calls itself injective-1,
    // and the pinned injective client has expired
    const spoofed = [r('injective-1', 18, 494, false), r('injective-1', 99, 7, true)];
    expect(pinnedRouteStatus(spoofed, pin(18, 494))).toBe('inactive');
  });

  it('a node that reports the pinned channel with another counterparty is refused', () => {
    expect(pinnedRouteStatus([r('noble-1', 2, 666, true)], pin(2, 89))).toBe('inactive');
  });

  it('a pin the node does not report at all is refused', () => {
    expect(pinnedRouteStatus(routes, pin(2, 89))).toBe('inactive');
  });

  it('the reported chain id is not read: only the pair decides', () => {
    expect(pinnedRouteStatus([r('anything', 2, 89, true)], pin(2, 89))).toBe('active');
  });
});
