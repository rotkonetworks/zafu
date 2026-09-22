/**
 * Canonical byte encoding for anything this SDK signs.
 *
 * Every signed structure here uses the same discipline, and it is deliberately
 * boring: a domain separator, then length-prefixed fields, then a hash of the
 * payload when the payload is large. Two properties, both load-bearing:
 *
 *   - **domain separation**: bytes signed for a group envelope are never valid as
 *     a channel record. `'zid-group-v1'` and `'zid-chan-v1'` differ, so a
 *     signature cannot be replayed across structures;
 *   - **unambiguous framing**: every field is length-prefixed, so no two different
 *     field splits produce the same bytes - the classic `("ab", "c")` vs
 *     `("a", "bc")` collision that hand-concatenation invites.
 *
 * One file, one set of rules, so a second implementation in another language has
 * exactly this much to match.
 */

const enc = new TextEncoder();

/** big-endian u32: the only integer encoding used in signed bytes. */
export const u32be = (n: number): Uint8Array => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`canonical: ${n} does not fit a u32`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
};

/** length-prefixed bytes: the field boundary is inside the encoding, not implied. */
export const lp = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + bytes.length);
  out.set(u32be(bytes.length), 0);
  out.set(bytes, 4);
  return out;
};

export const utf8 = (text: string): Uint8Array => enc.encode(text);

/** a length-prefixed UTF-8 field. */
export const lpText = (text: string): Uint8Array => lp(utf8(text));

export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * The bytes signed for one record of a signed structure: domain, then the fields
 * in the order given. Callers pass already-encoded fields (numbers via `u32be`,
 * strings and blobs via `lp`/`lpText`), so the encoding is explicit at the call
 * site rather than hidden in a serializer nobody reads.
 */
export const signedFields = (domain: string, fields: readonly Uint8Array[]): Uint8Array =>
  concat([utf8(domain), ...fields.map(lp)]);
