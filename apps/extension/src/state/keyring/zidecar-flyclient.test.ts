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
      Promise.resolve(new Response(frame(proof))),
    );
    vi.stubGlobal('fetch', fetch);
    const got = await new ZidecarClient('https://node.example/').getFlyClientProof(17, 1 << 20);
    expect(got).toEqual(proof);
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

  test('a standard lightwalletd has no way to be asked', () => {
    expect(zidecarExtras('https://lwd.example', 'lightwalletd')).toBeUndefined();
  });
});
