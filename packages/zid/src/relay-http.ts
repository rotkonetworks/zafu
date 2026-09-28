/**
 * HTTP relay transport for private contact discovery.
 *
 * `contact-relay.ts` defines `RelayTransport` but ships no network
 * implementation - only test doubles. This is the real one: a dumb key-value
 * relay addressed by `(appScope, epoch, shard)` over plain HTTP.
 *
 * A reference SERVER implementing the contract below lives in `apps/minirelay`
 * (Rust + SQLite, two routes, no crypto) - run it, or write your own against the
 * same contract. Note there is no npm package for the server side on purpose: a
 * relay is a service somebody runs, and the SDK already carries the client.
 *
 * ===========================================================================
 * WIRE CONTRACT - exactly what a server MUST implement
 * ===========================================================================
 *
 *   PUT bucket   POST  <endpoint>/bucket
 *     Content-Type: application/json
 *     { "appScope": string, "epoch": number, "shard": string,
 *       "entries": [ { "tag": <base64>, "blob": <base64> }, ... ] }
 *     -> any 2xx; the body is ignored. MERGE the entries into the coordinate,
 *        KEYED BY TAG: an entry whose tag already exists replaces it, every other
 *        entry stays. Do NOT replace the whole coordinate with this batch.
 *
 *        Why merge-by-tag and not replace: a coordinate holds one padded batch per
 *        PUBLISHER, and `ContactRelay.publishPresence` never reads before it
 *        writes, so a replace would silently drop every publisher but the last and
 *        discovery would only ever find one friend per scope. Keying by tag also
 *        makes a RETRY safe: a real tag is unique per (publisher, epoch) by
 *        construction (HKDF output), so re-publishing overwrites the publisher's
 *        own real entries instead of duplicating them. Dummies are random per
 *        publish, so a retry does add another batch's worth of them - harmless,
 *        since dummies are indistinguishable from reals by design and the whole
 *        coordinate is dropped at epoch rotation, but it is why the cap below
 *        exists.
 *
 *        Nothing on the wire says which batch is whose, and the relay must not try
 *        to infer it.
 *
 *   GET bucket   GET   <endpoint>/bucket?appScope=<url-encoded>&epoch=<n>&shard=<url-encoded>
 *     -> 2xx with JSON { "entries": [ { "tag": <base64>, "blob": <base64> }, ... ] }
 *        for that coordinate, or an empty `entries` array when nothing was
 *        published. Any other shape is a contract violation and is rejected.
 *
 *   Retention    A relay SHOULD drop coordinates for epochs that have passed.
 *                Old epochs are useless to readers (tags rotate every epoch) and
 *                the presence layer has no forward secrecy by design, so keeping
 *                them only lengthens the window in which a later key compromise
 *                reconstructs who was online when.
 *
 *   Limits       Floors and ceilings. The server MUST accept a batch of at least
 *                PRESENCE_PAD_TO entries per request (clients write a constant 64
 *                per epoch - splitting a batch would change the write shape and
 *                leak the friend count the padding exists to hide) and MUST NOT
 *                rate-limit a client below one publish plus one fetch per epoch.
 *                It SHOULD bound a coordinate: an honest client contributes one
 *                batch per epoch, so a coordinate that keeps growing within an
 *                epoch is abuse (a hostile client can append random tags without
 *                limit). A cap in the low multiples of the expected entries,
 *                enforced by rejecting further writes or dropping the coordinate,
 *                keeps a single client from inflating everyone's download.
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

/**
 * Client-side ceiling on what an untrusted relay may make us decode. An honest
 * client contributes one padded batch (PRESENCE_PAD_TO = 64) per epoch, so a
 * cap of a few batches bounds a hostile relay without clipping legitimate data.
 */
export const MAX_RELAY_ENTRIES = 256;
/** generous base64 ceiling for one tag (32 B) or blob (64 B) - anything longer is discarded. */
export const MAX_RELAY_ENTRY_BASE64 = 1024;

/**
 * Client-side ceiling on what an untrusted relay may make us BUFFER. An honest
 * bucket is at most MAX_RELAY_ENTRIES entries of two MAX_RELAY_ENTRY_BASE64
 * fields (well under 0.5 MB), so 1 MiB accepts any legal response and still
 * bounds a hostile one.
 *
 * This is the read-side twin of MAX_RELAY_ENTRIES, and it is not redundant:
 * `JSON.parse` allocates the whole body before `parseEntries` can cap a single
 * entry, so the count/cap checks alone still let a relay hand us a 2 GB body to
 * materialise first. The limit is applied while reading, not after.
 */
export const MAX_RELAY_BODY_BYTES = 1024 * 1024;

/** read a relay response body, refusing to buffer more than the ceiling above. */
async function readBoundedBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    // a Response without a stream (an exotic implementation or a test double)
    const text = await res.text();
    if (text.length > MAX_RELAY_BODY_BYTES) {
      throw new Error(`relay: response body exceeds ${MAX_RELAY_BODY_BYTES} bytes`);
    }
    return text;
  }
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    bytes += value.byteLength;
    if (bytes > MAX_RELAY_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`relay: response body exceeds ${MAX_RELAY_BODY_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** parse the `{ entries: [{ tag, blob }] }` body, rejecting anything else loudly. */
function parseEntries(body: unknown): PresenceEntry[] {
  if (typeof body !== 'object' || body === null) {
    throw new Error('relay: response is not a JSON object');
  }
  if (!('entries' in body)) {
    throw new Error('relay: response has no `entries` array');
  }
  const entries = body.entries;
  if (!Array.isArray(entries)) {
    throw new Error('relay: response has no `entries` array');
  }
  // DEFECT C: never decode an unbounded batch from untrusted relay output - cap
  // the count and drop any entry whose encoded fields exceed the ceiling.
  const parsed: PresenceEntry[] = [];
  for (let i = 0; i < entries.length && parsed.length < MAX_RELAY_ENTRIES; i++) {
    const raw: unknown = entries[i];
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`relay: entry ${i} is not an object`);
    }
    if (!('tag' in raw) || !('blob' in raw)) {
      throw new Error(`relay: entry ${i} must carry base64 strings for tag and blob`);
    }
    const tag = raw.tag;
    const blob = raw.blob;
    if (typeof tag !== 'string' || typeof blob !== 'string') {
      throw new Error(`relay: entry ${i} must carry base64 strings for tag and blob`);
    }
    if (tag.length > MAX_RELAY_ENTRY_BASE64 || blob.length > MAX_RELAY_ENTRY_BASE64) {
      continue; // discard an oversized entry rather than decode it
    }
    try {
      parsed.push({ tag: base64ToBytes(tag), blob: base64ToBytes(blob) });
    } catch {
      throw new Error(`relay: entry ${i} carries invalid base64`);
    }
  }
  return parsed;
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
      const raw = await readBoundedBody(res);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error('relay: response body is not JSON');
      }
      return parseEntries(body);
    },
  };
}
