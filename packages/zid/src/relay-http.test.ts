import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  createHttpRelayTransport,
  MAX_RELAY_BODY_BYTES,
  MAX_RELAY_ENTRIES,
  MAX_RELAY_ENTRY_BASE64,
} from './relay-http';

const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

/**
 * The narrow slice of Response the transport uses.
 *
 * The body is a real ReadableStream, delivered in chunks, so these tests
 * exercise the transport's bounded read (and its ceiling) rather than a
 * single-shot shortcut a real relay would never provide.
 */
function streamedResponse(text: string, status = 200) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 64 * 1024) {
          c.enqueue(bytes.subarray(i, i + 64 * 1024));
        }
        c.close();
      },
    }),
    text: async () => text,
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  streamedResponse(JSON.stringify(body), status);

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

  it('rejects a body that is not JSON at all', async () => {
    const fetchMock = vi.fn(async () => streamedResponse('<html>proxy error</html>'));
    const transport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
    });

    await expect(transport.getBucket({ appScope: 'a', epoch: 1, shard: '' })).rejects.toThrow(
      /relay: response body is not JSON/,
    );
  });

  it('caps the entry count and discards an oversized entry from an untrusted relay', async () => {
    const tag = b64(new Uint8Array([1]));
    const blob = b64(new Uint8Array([2]));
    const entries: { tag: string; blob: string }[] = Array.from(
      { length: MAX_RELAY_ENTRIES + 50 },
      () => ({ tag, blob }),
    );
    // a valid base64 field longer than the ceiling would decode fine if it were
    // trusted - the transport must refuse it before calling atob.
    entries.splice(3, 0, { tag: 'A'.repeat(MAX_RELAY_ENTRY_BASE64 + 4), blob });
    const fetchMock = vi.fn(async () => jsonResponse({ entries }));
    const transport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
    });

    const out = await transport.getBucket({ appScope: 'a', epoch: 1, shard: '' });

    expect(out).toHaveLength(MAX_RELAY_ENTRIES); // excess beyond the cap dropped
    expect(out.every(e => e.tag.length <= 32)).toBe(true); // oversized entry discarded
    // never silent: the refusal is counted, not swallowed.
    expect(out.droppedOversize).toHaveLength(1);
    expect(out.droppedOversize[0]).toMatchObject({
      index: 3,
      base64Length: MAX_RELAY_ENTRY_BASE64 + 4,
    });
  });

  it('a caller with a bigger record size raises maxEntryBase64 and keeps the entry', async () => {
    // a 1053-byte sealed room record (1404 base64 chars) is exactly the shape
    // that discovery's 1024-char default silently dropped.
    const tag = b64(new Uint8Array(16).fill(1));
    const roomBlob = 'A'.repeat(1404);
    const fetchMock = vi.fn(async () => jsonResponse({ entries: [{ tag, blob: roomBlob }] }));
    const transport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
      maxEntryBase64: 2048,
    });

    const out = await transport.getBucket({ appScope: 'a', epoch: 1, shard: '' });

    expect(out).toHaveLength(1);
    expect(out.droppedOversize).toHaveLength(0);
  });

  it('the same 1404-char record is refused (and reported) at the unchanged discovery default', async () => {
    const tag = b64(new Uint8Array(16).fill(1));
    const roomBlob = 'A'.repeat(1404);
    const fetchMock = vi.fn(async () => jsonResponse({ entries: [{ tag, blob: roomBlob }] }));
    const transport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
    });

    const out = await transport.getBucket({ appScope: 'a', epoch: 1, shard: '' });

    expect(out).toHaveLength(0);
    expect(out.droppedOversize).toHaveLength(1);
    expect(out.droppedOversize[0]?.base64Length).toBe(1404);
  });

  it('a caller may also raise maxEntries and maxBodyBytes, independent of discovery defaults', async () => {
    const tag = b64(new Uint8Array([1]));
    const blob = b64(new Uint8Array([2]));
    const entries = Array.from({ length: MAX_RELAY_ENTRIES + 50 }, () => ({ tag, blob }));
    const fetchMock = vi.fn(async () => jsonResponse({ entries }));
    const transport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
      maxEntries: MAX_RELAY_ENTRIES + 50,
      maxBodyBytes: MAX_RELAY_BODY_BYTES * 4,
    });

    const out = await transport.getBucket({ appScope: 'a', epoch: 1, shard: '' });
    expect(out).toHaveLength(MAX_RELAY_ENTRIES + 50);

    // discovery's own defaults are untouched by another caller's options.
    const discoveryTransport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
    });
    const discoveryOut = await discoveryTransport.getBucket({ appScope: 'a', epoch: 1, shard: '' });
    expect(discoveryOut).toHaveLength(MAX_RELAY_ENTRIES);
  });

  it('stops reading an oversized body instead of buffering it for JSON.parse', async () => {
    // valid JSON with trailing whitespace: only the byte ceiling can reject this
    const huge = '{"entries":[]}' + ' '.repeat(MAX_RELAY_BODY_BYTES);
    const fetchMock = vi.fn(async () => streamedResponse(huge));
    const transport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
    });

    await expect(transport.getBucket({ appScope: 'a', epoch: 1, shard: '' })).rejects.toThrow(
      new RegExp(`exceeds ${MAX_RELAY_BODY_BYTES}`),
    );
  });

  it('bounds a response that carries no readable stream', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `{"entries":[]}`,
    }));
    const transport = createHttpRelayTransport({
      endpoint: 'https://r',
      fetch: asFetch(fetchMock),
    });

    const out = await transport.getBucket({ appScope: 'a', epoch: 1, shard: '' });
    expect(Array.from(out)).toEqual([]);
  });
});
