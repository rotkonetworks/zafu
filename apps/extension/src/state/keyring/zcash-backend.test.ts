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
      'getBlockTransactions' in ZCASH_BACKENDS.lightwalletd.client('https://zec.rocks:443'),
    ).toBe(false);
  });

  it('runs the mempool watch only when asked and on a zidecar', () => {
    expect(isMempoolWatchEnabled('on', 'zidecar')).toBe(true);
    expect(isMempoolWatchEnabled('on', 'lightwalletd')).toBe(false);
    expect(isMempoolWatchEnabled('off', 'zidecar')).toBe(false);
    expect(isMempoolWatchEnabled('on', 'constructor')).toBe(false);
  });

  it('has no independent peer once the primary is the only shipped preset', () => {
    expect(pickIndependentPeer('https://zcash.rotko.net')).toBeUndefined();
  });

  it('once the primary is pointed elsewhere, the shipped preset becomes the peer, for the peer own protocol', () => {
    const peer = pickIndependentPeer('https://zidecar.example.org');
    expect(peer && backendOfEndpoint(peer.url)).toBe('zidecar');
    expect(peer?.backend).toBe('zidecar');
  });
});
