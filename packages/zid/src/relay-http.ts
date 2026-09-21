/**
 * HTTP relay transport for private contact discovery.
 *
 * `contact-relay.ts` defines `RelayTransport` but ships no network
 * implementation - only test doubles. This is the real one: a dumb key-value
 * relay addressed by `(appScope, epoch, shard)` over plain HTTP.
 *
 * ===========================================================================
 * WIRE CONTRACT - exactly what a server MUST implement
 * ===========================================================================
 *
 *   PUT bucket   POST  <endpoint>/bucket
 *     Content-Type: application/json
 *     { "appScope": string, "epoch": number, "shard": string,
 *       "entries": [ { "tag": <base64>, "blob": <base64> }, ... ] }
 *     -> any 2xx; the body is ignored. Store the entries for the coordinate,
 *        REPLACING whatever was there for that (appScope, epoch, shard).
 *
 *   GET bucket   GET   <endpoint>/bucket?appScope=<url-encoded>&epoch=<n>&shard=<url-encoded>
 *     -> 2xx with JSON { "entries": [ { "tag": <base64>, "blob": <base64> }, ... ] }
 *        for that coordinate, or an empty `entries` array when nothing was
 *        published. Any other shape is a contract violation and is rejected.
 *
 * `tag` and `blob` are BYTES on the client side and base64 on the wire; nothing
 * else about them is interpreted here (the relay must not either - see below).
 *
 * ===========================================================================
 * THE INVARIANT THE SERVER MUST NOT BREAK
 * ===========================================================================
 * The relay MUST return the WHOLE bucket for a coordinate and MUST NOT offer a
 * per-tag lookup. Quoting `contact-relay.ts` verbatim: "A conforming relay is a
 * dumb key-value store keyed by `(appScope, epoch, shard)`; it MUST return the
 * whole bucket on read (that is invariant 1 - it must not offer per-tag lookup)."
 * A per-tag endpoint would let the operator watch which tags a client asks for
 * and rebuild social-graph edges even though every tag is opaque - it would
 * defeat the whole point of this transport. So there is deliberately no
 * single-entry route here either: `getBucket` can only fetch everything.
 */

import type { PresenceEntry, RelayTransport } from './contact-relay';

export interface HttpRelayTransportOptions {
  /** base URL of the relay, e.g. 'https://relay.example/zid'. No trailing slash needed. */
  endpoint: string;
  /** injectable fetch (tests); defaults to the global. */
  fetch?: typeof fetch;
  /** extra request headers (auth, etc.). Merged over the JSON default. */
  headers?: Record<string, string>;
}

// -- base64 (browser btoa/atob; chunked so a large bucket cannot blow the
//    String.fromCharCode argument limit that a spread over the whole array would) --

const bytesToBase64 = (bytes: Uint8Array): string => {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
};

const base64ToBytes = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** parse the `{ entries: [{ tag, blob }] }` body, rejecting anything else loudly. */
function parseEntries(body: unknown): PresenceEntry[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('relay: response is not a JSON object');
  }
  const entries = (body as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error('relay: response has no `entries` array');
  }
  return entries.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`relay: entry ${i} is not an object`);
    }
    const { tag, blob } = raw as { tag?: unknown; blob?: unknown };
    if (typeof tag !== 'string' || typeof blob !== 'string') {
      throw new Error(`relay: entry ${i} must carry base64 strings for tag and blob`);
    }
    try {
      return { tag: base64ToBytes(tag), blob: base64ToBytes(blob) };
    } catch {
      throw new Error(`relay: entry ${i} carries invalid base64`);
    }
  });
}

/** the relay transport from the wire contract above. */
export function createHttpRelayTransport(opts: HttpRelayTransportOptions): RelayTransport {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = opts.endpoint.replace(/\/+$/, '');
  const bucketUrl = `${base}/bucket`;
  const headers = { 'content-type': 'application/json', ...opts.headers };

  return {
    async putBucket(req) {
      const res = await doFetch(bucketUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          appScope: req.appScope,
          epoch: req.epoch,
          shard: req.shard,
          entries: req.entries.map(e => ({
            tag: bytesToBase64(e.tag),
            blob: bytesToBase64(e.blob),
          })),
        }),
      });
      if (!res.ok) {
        throw new Error(`relay: putBucket failed with HTTP ${res.status}`);
      }
    },

    async getBucket(req) {
      const url = `${bucketUrl}?appScope=${encodeURIComponent(req.appScope)}&epoch=${req.epoch}&shard=${encodeURIComponent(req.shard)}`;
      const res = await doFetch(url, { headers });
      if (!res.ok) {
        throw new Error(`relay: getBucket failed with HTTP ${res.status}`);
      }
      return parseEntries(await res.json());
    },
  };
}
