import { describe, expect, it } from 'vitest';
import { ZCASH_BACKENDS, backendOfEndpoint, zidecarExtras } from './zcash-backend';
import { isMempoolWatchEnabled } from '../../services/mempool-watch/strategy';
import { pickIndependentPeer } from '../../workers/cross-verify';

describe('zcash backends', () => {
  it('reaches zidecar rpcs only behind a zidecar', () => {
    expect(zidecarExtras('https://zcash.rotko.net', 'zidecar')).toBeDefined();
    expect(zidecarExtras('https://zec.rocks:443', 'lightwalletd')).toBeUndefined();
    expect(zidecarExtras('https://zec.rocks:443', 'toString')).toBeUndefined();
    expect(
      'getNullifierProofs' in ZCASH_BACKENDS.lightwalletd.client('https://zec.rocks:443'),
    ).toBe(false);
  });

  it('runs the mempool watch only when asked and on a zidecar', () => {
    expect(isMempoolWatchEnabled('on', 'zidecar')).toBe(true);
    expect(isMempoolWatchEnabled('on', 'lightwalletd')).toBe(false);
    expect(isMempoolWatchEnabled('off', 'zidecar')).toBe(false);
    expect(isMempoolWatchEnabled('on', 'constructor')).toBe(false);
  });

  it('builds the cross-check peer for the peer own protocol', () => {
    const peer = pickIndependentPeer('https://zcash.rotko.net');
    expect(peer && backendOfEndpoint(peer.url)).toBe('lightwalletd');
    expect(peer?.backend).toBe('lightwalletd');
  });
});
