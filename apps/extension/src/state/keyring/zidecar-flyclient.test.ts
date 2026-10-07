import { afterEach, describe, expect, test, vi } from 'vitest';
import { ZidecarClient } from './zidecar-client';
import { zidecarExtras } from './zcash-backend';

const frame = (payload: Uint8Array) => {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
};

describe('GetFlyClientProof', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('asks with default lambda/tail and a burial, and returns the raw response', async () => {
    const proof = Uint8Array.from([0x0a, 0x02, 0x08, 0x01, 0x10, 0x05]);
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        new Response(frame(proof), { headers: { date: 'Wed, 07 Oct 2026 05:29:02 GMT' } }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const got = await new ZidecarClient('https://node.example/').getFlyClientProof(17, 1 << 20);
    expect(got.proof).toEqual(proof);
    // the node's own clock, for telling a stale tip from a wrong local clock
    expect(got.serverTime).toBe(Date.UTC(2026, 9, 7, 5, 29, 2));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://node.example/zidecar.v1.Zidecar/GetFlyClientProof');
    // grpc-web frame around FlyClientProofRequest { burial: 17 }
    expect(new Uint8Array(init.body as Uint8Array)).toEqual(
      Uint8Array.from([0, 0, 0, 0, 2, 0x18, 17]),
    );
  });

  test('a response past the cap is refused before it is all read', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(frame(new Uint8Array(4096)))));
    await expect(
      new ZidecarClient('https://node.example').getFlyClientProof(17, 1024),
    ).rejects.toThrow(/over 1024 bytes/);
  });

  test('a node without the rpc says so with its grpc status', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(new Uint8Array(0), {
          headers: {
            'grpc-status': '12',
            'grpc-message': 'FlyClient%20proofs%20are%20not%20enabled',
          },
        }),
      ),
    );
    await expect(
      new ZidecarClient('https://node.example').getFlyClientProof(17, 1024),
    ).rejects.toMatchObject({ grpcStatus: 12 });
  });

  test('a standard lightwalletd has no way to be asked', () => {
    expect(zidecarExtras('https://lwd.example', 'lightwalletd')).toBeUndefined();
  });
});
