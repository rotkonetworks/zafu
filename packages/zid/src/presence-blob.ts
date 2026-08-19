/**
 * Presence-blob AEAD — the payload layer that rides under a rendezvous tag.
 *
 * Contact discovery has two layers:
 *   - WHERE to look: the rendezvous TAG (see `contact-discovery.ts`), a public
 *     per-epoch key-value coordinate the blind relay indexes on.
 *   - WHAT is stored there: this PRESENCE BLOB, an AEAD-sealed record so the
 *     relay sees only ciphertext and a stale/replayed blob is rejected.
 *
 * Both derive from the SAME opaque pairwise `rootSecret`, but under DISTINCT
 * HKDF domains, so the tag (which is published in the clear) is never usable as
 * the encryption key. The tag uses label `'zid-rvz-v1'`; the AEAD key uses
 * `'zid-presence-v1'` — different `info`, different HKDF output, full key
 * separation.
 *
 * Suite-blind, exactly like the tag layer: `rootSecret` is opaque bytes and
 * nothing here cares whether it came from X25519 DH or a PQ hybrid.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// wire format + crypto constants
// ---------------------------------------------------------------------------

/**
 * HKDF domain label for the AEAD key. MUST differ from the rendezvous tag's
 * `'zid-rvz-v1'` — this difference IS the key-separation guarantee: the same
 * `rootSecret` never yields both the public tag and the secret key.
 */
const PRESENCE_KDF_LABEL = 'zid-presence-v1';

/** presence-blob wire-format version (first byte of every blob). */
export const PRESENCE_BLOB_VERSION = 0x01;

/** AES-256-GCM key length, bytes. */
const AEAD_KEY_BYTES = 32;

/** GCM nonce length, bytes (96-bit, the AES-GCM standard). */
const NONCE_BYTES = 12;

/** GCM authentication-tag length, bytes (128-bit). */
const TAG_BYTES = 16;

/** smallest possible blob: version + nonce + (empty ct + tag). */
const MIN_BLOB_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

/**
 * Direction of a pairwise presence beacon. A pairwise link has two independent
 * streams; each uses a DISTINCT AEAD key so one direction's blob can never be
 * opened (or replayed) as the other's.
 *
 * Convention — pin this so both peers agree: `dir` names the PUBLISHER by the
 * lexicographic order of the two contact-card pubkeys. `'a2b'` = the party with
 * the smaller pubkey announcing to the larger; `'b2a'` = the reverse. To open a
 * peer's beacon, pass the same `dir` they sealed under.
 */
export type PresenceDir = 'a2b' | 'b2a';

const dirByte = (dir: PresenceDir): number => {
  switch (dir) {
    case 'a2b':
      return 0x00;
    case 'b2a':
      return 0x01;
  }
};

// ---------------------------------------------------------------------------
// domain-separated field encoding (mirrors contact-discovery.ts helpers)
// ---------------------------------------------------------------------------

const u32be = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  // setUint32 applies ToUint32, so the value is coerced to 32-bit big-endian.
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
};

const concatBytes = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/**
 * Copy into a fresh, ArrayBuffer-backed view. Web Crypto's `BufferSource`
 * requires `Uint8Array<ArrayBuffer>` (not the `ArrayBufferLike` a `@noble` HKDF
 * result or a `subarray` may carry); this coercion satisfies the type and
 * detaches from any shared/pooled backing buffer. Presence blobs are tiny, so
 * the copy cost is irrelevant.
 */
const asArrayBuffer = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
};

/**
 * Additional authenticated data. Binds the epoch (anti-replay), app origin, and
 * direction into the GCM tag. Because the relay cannot forge this tag, it cannot
 * lift a previous epoch's blob into the current epoch's tag slot — the epoch in
 * the AAD will not match and `open` returns null. Every field is fixed-length,
 * so the concatenation is unambiguous.
 */
const presenceAad = (appOrigin: string, epoch: number, dir: PresenceDir): Uint8Array<ArrayBuffer> =>
  concatBytes(
    Uint8Array.of(PRESENCE_BLOB_VERSION), // 1
    sha256(enc.encode(appOrigin)), // 32
    u32be(epoch), // 4
    Uint8Array.of(dirByte(dir)), // 1
  );

/**
 * Derive the per-(app, epoch, dir) AES-256-GCM key from the pairwise root
 * secret. Epoch-in-`info` gives cross-epoch key rotation; the `'zid-presence-v1'`
 * label separates this key from the rendezvous tag. Fixed-length fields keep the
 * `info` string unambiguous regardless of `appOrigin` length.
 */
const deriveAeadKey = async (
  rootSecret: Uint8Array,
  appOrigin: string,
  epoch: number,
  dir: PresenceDir,
): Promise<CryptoKey> => {
  const info = concatBytes(
    enc.encode(PRESENCE_KDF_LABEL),
    sha256(enc.encode(appOrigin)), // fixed 32
    u32be(epoch), // fixed 4
    Uint8Array.of(dirByte(dir)), // fixed 1
  );
  const keyBytes = hkdf(sha256, rootSecret, undefined, info, AEAD_KEY_BYTES);
  return crypto.subtle.importKey('raw', asArrayBuffer(keyBytes), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
};

// ---------------------------------------------------------------------------
// seal / open
// ---------------------------------------------------------------------------

/**
 * Seal a presence record for `(appOrigin, epoch, dir)` under the pairwise
 * `rootSecret`. Output layout: `version(1) ‖ nonce(12) ‖ ciphertext+tag`. The
 * 12-byte GCM nonce is random per call and prepended in the clear (safe — GCM
 * only needs nonce uniqueness, not secrecy).
 */
export const sealPresence = async (
  rootSecret: Uint8Array,
  appOrigin: string,
  epoch: number,
  dir: PresenceDir,
  plaintext: Uint8Array,
): Promise<Uint8Array> => {
  const key = await deriveAeadKey(rootSecret, appOrigin, epoch, dir);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: presenceAad(appOrigin, epoch, dir) },
      key,
      asArrayBuffer(plaintext),
    ),
  );
  return concatBytes(Uint8Array.of(PRESENCE_BLOB_VERSION), nonce, ct);
};

/**
 * Open a presence blob. Returns the plaintext, or `null` on ANY failure —
 * malformed length, unknown version, or a failed GCM tag (tampering, wrong
 * epoch/app/dir, or a replayed cross-epoch blob). Never throws: garbage from an
 * untrusted relay is dropped silently client-side, so callers can treat a slot
 * as "no valid presence" without a try/catch.
 */
export const openPresence = async (
  rootSecret: Uint8Array,
  appOrigin: string,
  epoch: number,
  dir: PresenceDir,
  blob: Uint8Array,
): Promise<Uint8Array | null> => {
  if (blob.length < MIN_BLOB_BYTES) {
    return null;
  }
  if (blob[0] !== PRESENCE_BLOB_VERSION) {
    return null;
  }

  const nonce = asArrayBuffer(blob.subarray(1, 1 + NONCE_BYTES));
  const ct = asArrayBuffer(blob.subarray(1 + NONCE_BYTES));
  try {
    const key = await deriveAeadKey(rootSecret, appOrigin, epoch, dir);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: presenceAad(appOrigin, epoch, dir) },
      key,
      ct,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// presence record — the small, versioned plaintext payload
// ---------------------------------------------------------------------------

/** presence-record wire-format version. */
export const PRESENCE_RECORD_VERSION = 0x01;

/** app-scoped session pubkey length, bytes (X25519 / Ed25519 raw). */
const SESSION_PUB_BYTES = 32;

/** fixed encoded record size: version(1) + sessionPub(32) + caps(2). */
const PRESENCE_RECORD_BYTES = 1 + SESSION_PUB_BYTES + 2;

/**
 * The presence payload: an app-scoped EPHEMERAL session pubkey the peer can dial
 * back on, plus a 16-bit `caps` hint (app-defined capability/status bits). Kept
 * deliberately small and fixed-size so ciphertext length leaks nothing.
 */
export interface PresenceRecord {
  /** 32-byte app-scoped ephemeral session public key. */
  sessionPub: Uint8Array;
  /** app-defined capability/status bit hint (0..65535). */
  caps: number;
}

/** Encode a {@link PresenceRecord} to its fixed 35-byte wire form. */
export const encodePresenceRecord = (rec: PresenceRecord): Uint8Array => {
  if (rec.sessionPub.length !== SESSION_PUB_BYTES) {
    throw new Error(`presence: sessionPub must be ${SESSION_PUB_BYTES} bytes`);
  }
  const out = new Uint8Array(PRESENCE_RECORD_BYTES);
  out[0] = PRESENCE_RECORD_VERSION;
  out.set(rec.sessionPub, 1);
  // setUint16 applies ToUint16, coercing caps into the 16-bit big-endian slot.
  new DataView(out.buffer).setUint16(1 + SESSION_PUB_BYTES, rec.caps, false);
  return out;
};

/** Decode a presence-record wire form, or `null` if malformed / wrong version. */
export const decodePresenceRecord = (bytes: Uint8Array): PresenceRecord | null => {
  if (bytes.length !== PRESENCE_RECORD_BYTES) {
    return null;
  }
  if (bytes[0] !== PRESENCE_RECORD_VERSION) {
    return null;
  }
  const sessionPub = bytes.slice(1, 1 + SESSION_PUB_BYTES);
  const caps = new DataView(bytes.buffer, bytes.byteOffset).getUint16(1 + SESSION_PUB_BYTES, false);
  return { sessionPub, caps };
};
