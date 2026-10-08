import { describe, expect, it, vi } from 'vitest';
import { ZCASH_BACKENDS, zidecarExtras } from './zcash-backend';
import { ZidecarClient } from './zidecar-client';
import { isMempoolWatchEnabled } from '../../services/mempool-watch/strategy';

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

  it('hears a node that already holds this very transaction as sent, and nothing else', async () => {
    const te = new TextEncoder();
    // SendResponse { errorCode: -1, errorMessage }, as zidecar answers a zebra error
    const answer = (message: string) => {
      const m = te.encode(message);
      return new Uint8Array([0x10, ...Array(9).fill(0xff), 0x01, 0x1a, m.length, ...m]);
    };
    const client = new ZidecarClient('https://zcash.rotko.net');
    const grpc = vi.spyOn(client as unknown as { grpcCall: () => Promise<Uint8Array> }, 'grpcCall');
    for (const sent of [
      'transaction already exists in mempool',
      'transaction dropped because it is already queued for download',
      'transaction is already in state',
    ]) {
      grpc.mockResolvedValueOnce(answer(`zebrad rpc: ${sent}`));
      expect(await client.sendTransaction(new Uint8Array([1]))).toMatchObject({ errorCode: 0 });
    }
    grpc.mockResolvedValueOnce(answer('orchard double-spend: duplicate nullifier'));
    expect((await client.sendTransaction(new Uint8Array([1]))).errorCode).not.toBe(0);
  });
});
