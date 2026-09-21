import { describe, expect, it, vi, type Mock } from 'vitest';
import { createHttpRelayTransport } from './relay-http';

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

/** the narrow slice of Response the transport uses. */
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

type FetchMock = Mock;

/** first fetch call as [url, init], with a loud failure if none happened. */
function firstCall(fetchMock: FetchMock): [string, RequestInit] {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error('expected a fetch call');
  }
  return call as [string, RequestInit];
}

const asFetch = (mock: FetchMock): typeof fetch => mock as unknown as typeof fetch;

describe('createHttpRelayTransport', () => {
  it('POSTs the bucket coordinates with base64 entries', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const transport = createHttpRelayTransport({
      endpoint: 'https://relay.example/zid/',
      fetch: asFetch(fetchMock),
    });
    const tag = new Uint8Array([1, 2, 3]);
    const blob = new Uint8Array([4, 5]);

    await transport.putBucket({ appScope: 'app', epoch: 7, shard: '', entries: [{ tag, blob }] });

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://relay.example/zid/bucket'); // trailing slash trimmed
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      appScope: 'app',
      epoch: 7,
      shard: '',
      entries: [{ tag: b64(tag), blob: b64(blob) }],
    });
  });

  it('GETs the whole bucket for the coordinate and decodes base64 back to bytes', async () => {
    const tag = new Uint8Array([9, 9, 9, 9]);
    const blob = new Uint8Array([7, 7]);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ entries: [{ tag: b64(tag), blob: b64(blob) }] }),
    );
    const transport = createHttpRelayTransport({
      endpoint: 'https://relay.example/zid',
      fetch: asFetch(fetchMock),
    });

    const out = await transport.getBucket({ appScope: 'app', epoch: 7, shard: 'ab cd' });

    const [url, init] = firstCall(fetchMock);
    expect(url).toContain('appScope=app');
    expect(url).toContain('epoch=7');
    expect(url).toContain('shard=ab%20cd');
    expect(url).not.toContain('tag='); // never a per-tag lookup: whole bucket only
    expect(init.method).toBeUndefined();

    const entry = out[0];
    if (!entry) {
      throw new Error('expected one entry');
    }
    expect(Array.from(entry.tag)).toEqual([9, 9, 9, 9]);
    expect(Array.from(entry.blob)).toEqual([7, 7]);
  });

  it('rejects a non-2xx response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    const transport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
    });

    await expect(transport.getBucket({ appScope: 'a', epoch: 1, shard: '' })).rejects.toThrow(
      /503/,
    );
  });

  it('rejects a malformed bucket body rather than returning garbage', async () => {
    const bodies = [
      {},
      { entries: 'nope' },
      { entries: [{ tag: 1, blob: 'x' }] },
      { entries: [{ tag: '!!', blob: '' }] },
    ];

    for (const body of bodies) {
      const fetchMock = vi.fn(async () => jsonResponse(body));
      const transport = createHttpRelayTransport({
        endpoint: 'https://r',
        fetch: asFetch(fetchMock),
      });
      await expect(transport.getBucket({ appScope: 'a', epoch: 1, shard: '' })).rejects.toThrow(
        /relay:/,
      );
    }
  });
});
