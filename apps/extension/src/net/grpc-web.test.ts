import { afterEach, describe, expect, test, vi } from 'vitest';
import { grpcWebFetch, grpcWebFrame, grpcWebUnaryMessage } from './grpc-web';

describe('grpcWebFrame', () => {
  test('flag byte, big-endian length, message', () => {
    const msg = new Uint8Array(0x10203).fill(7);
    const f = grpcWebFrame(msg);
    expect([...f.subarray(0, 5)]).toEqual([0, 0, 1, 2, 3]);
    expect(f.subarray(5)).toEqual(msg);
  });
});

describe('grpcWebFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('headers seen before the body; a body past maxBytes is refused', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(new Uint8Array(100), { headers: { date: 'x' } })),
    );
    const seen: string[] = [];
    await expect(
      grpcWebFetch('https://n', 's', 'M', new Uint8Array(0), {
        maxBytes: 50,
        onHeaders: h => seen.push(h.get('date') ?? ''),
      }),
    ).rejects.toThrow('gRPC M: response over 50 bytes');
    expect(seen).toEqual(['x']);
  });

  test('sends only the grpc-web headers: no caller can add one', async () => {
    const fetch = vi.fn((_u: string, _i: RequestInit) => Promise.resolve(new Response('')));
    vi.stubGlobal('fetch', fetch);
    await grpcWebFetch('https://n', 's', 'M', new Uint8Array(0));
    expect(fetch.mock.calls[0]![0]).toBe('https://n/s/M');
    expect(fetch.mock.calls[0]![1].headers).toEqual({
      'Content-Type': 'application/grpc-web+proto',
      Accept: 'application/grpc-web+proto',
      'x-grpc-web': '1',
    });
  });
});

describe('grpcWebUnaryMessage', () => {
  const ok = new Response('');
  test('a trailers-only error in the headers', () => {
    const resp = new Response('', { headers: { 'grpc-status': '12', 'grpc-message': 'no%20rpc' } });
    expect(() => grpcWebUnaryMessage(resp, new Uint8Array(0), 'M', 'https://n')).toThrow(
      expect.objectContaining({ message: 'gRPC M: no rpc', grpcStatus: 12 }) as Error,
    );
  });

  test('the first data frame only', () => {
    const buf = Uint8Array.from([0, 0, 0, 0, 2, 9, 8, 0, 0, 0, 0, 1, 7]);
    expect(grpcWebUnaryMessage(ok, buf, 'M', 'https://n')).toEqual(Uint8Array.from([9, 8]));
  });
});
