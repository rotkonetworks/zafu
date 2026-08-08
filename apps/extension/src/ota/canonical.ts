/**
 * Strict canonical CBOR (RFC 8949) for the Zafu firmware-OTA wire contract.
 *
 * This module implements the ONE frozen serialization used by every signed
 * form in the OTA spec (see docs/design/zafu-ota-wire-freeze.md). The wallet
 * side and the device side MUST produce byte-exact identical output.
 *
 * Rules enforced (freeze doc):
 *   - definite-length maps, integer keys in ASCENDING order
 *   - minimal integer encoding (0x00..0x17 for 0..23, then 0x18..)
 *   - definite-length tstr / bstr only (no indefinite lengths)
 *   - booleans only (0xf4 / 0xf5)
 *   - decoder rejects: trailing bytes, duplicate keys, indefinite lengths,
 *     non-minimal integers, and any major type we never emit.
 */

export type CborValue = number | bigint | string | Uint8Array | boolean | CborMap;

/** A CBOR map with integer keys (ascending, no duplicates). */
export type CborMap = Map<number, CborValue>;

export type CborDecoded = number | string | Uint8Array | boolean | CborMap;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class OtaCborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtaCborError';
  }
}

// ---------------------------------------------------------------------------
// low-level helpers
// ---------------------------------------------------------------------------

export function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function need(bytes: Uint8Array, offset: number, count: number, what: string): void {
  if (offset + count > bytes.length) {
    throw new OtaCborError(`truncated ${what}`);
  }
}

/** Canonical minimal-length uint argument for a major-type prefix. */
function argHead(major: number, value: number): Uint8Array {
  const base = major << 5;
  let out: number[];
  if (value < 0x18) {
    out = [base + value];
  } else if (value < 0x100) {
    out = [base + 0x18, value];
  } else if (value < 0x10000) {
    out = [base + 0x19, value >> 8, value & 0xff];
  } else if (value < 0x1_0000_0000) {
    out = [
      base + 0x1a,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
  } else {
    if (!Number.isSafeInteger(value)) {
      throw new OtaCborError(`integer out of safe range: ${value}`);
    }
    const hi = Math.floor(value / 0x1_0000_0000);
    const lo = value >>> 0;
    out = [
      base + 0x1b,
      (hi >>> 24) & 0xff,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      (lo >>> 24) & 0xff,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff,
    ];
  }
  return new Uint8Array(out);
}

/** Cursor position tracker for the decoder. */
interface Cursor {
  value: CborDecoded;
  next: number;
}

function readLen(bytes: Uint8Array, start: number, what: string): { value: number; next: number } {
  if (start >= bytes.length) {
    throw new OtaCborError(`truncated ${what}`);
  }
  const head = bytes[start]! & 0x1f;
  if (head < 0x18) {
    return { value: head, next: start + 1 };
  }
  let next: number;
  let value: number;
  let min: number;
  switch (head) {
    case 0x18: {
      need(bytes, start + 1, 1, what);
      value = bytes[start + 1]!;
      min = 0x18;
      next = start + 2;
      break;
    }
    case 0x19: {
      need(bytes, start + 1, 2, what);
      value = (bytes[start + 1]! << 8) | bytes[start + 2]!;
      min = 0x100;
      next = start + 3;
      break;
    }
    case 0x1a: {
      need(bytes, start + 1, 4, what);
      value =
        ((bytes[start + 1]! << 24) |
          (bytes[start + 2]! << 16) |
          (bytes[start + 3]! << 8) |
          bytes[start + 4]!) >>>
        0;
      min = 0x1_0000;
      next = start + 5;
      break;
    }
    case 0x1b: {
      need(bytes, start + 1, 8, what);
      const hi =
        ((bytes[start + 1]! << 24) |
          (bytes[start + 2]! << 16) |
          (bytes[start + 3]! << 8) |
          bytes[start + 4]!) >>>
        0;
      const lo =
        ((bytes[start + 5]! << 24) |
          (bytes[start + 6]! << 16) |
          (bytes[start + 7]! << 8) |
          bytes[start + 8]!) >>>
        0;
      value = hi * 0x1_0000_0000 + lo;
      min = 0x1_0000_0000;
      next = start + 9;
      if (!Number.isSafeInteger(value)) {
        throw new OtaCborError(`integer out of safe range for ${what}`);
      }
      break;
    }
    default:
      throw new OtaCborError(`indefinite/reserved length for ${what} is forbidden (non-canonical)`);
  }
  if (value < min) {
    throw new OtaCborError(`non-minimal integer encoding for ${what}`);
  }
  return { value, next };
}

// ---------------------------------------------------------------------------
// public encoders
// ---------------------------------------------------------------------------

/** Encode an unsigned integer with canonical minimal encoding. */
export function encodeUint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new OtaCborError(`encodeUint requires a non-negative integer, got ${value}`);
  }
  return argHead(0, value);
}

/** Encode a definite-length text string. */
export function encodeTstr(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  return concat(argHead(3, bytes.length), bytes);
}

/** Encode a definite-length byte string. */
export function encodeBstr(value: Uint8Array): Uint8Array {
  return concat(argHead(2, value.length), value);
}

/** Encode a boolean. */
export function encodeBool(value: boolean): Uint8Array {
  return new Uint8Array(value ? [0xf5] : [0xf4]);
}

/** Encode a map with integer keys, sorted ascending. Rejects dup/unsorted. */
export function encodeMap(entries: Iterable<[number, CborValue]>): Uint8Array {
  const sorted: [number, CborValue][] = [...entries];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i]![0] >= sorted[i + 1]![0]) {
      throw new OtaCborError('map keys must be strictly ascending');
    }
  }
  const parts: Uint8Array[] = [argHead(5, sorted.length)];
  for (const [key, value] of sorted) {
    parts.push(encodeUint(key), encode(value));
  }
  return concat(...parts);
}

/** Recursively encode any supported canonical CBOR value. */
export function encode(value: CborValue): Uint8Array {
  if (typeof value === 'number') {
    return encodeUint(value);
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new OtaCborError('negative bigints unsupported');
    }
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      throw new OtaCborError(`bigint out of safe range: ${value}`);
    }
    return encodeUint(n);
  }
  if (typeof value === 'string') {
    return encodeTstr(value);
  }
  if (value instanceof Uint8Array) {
    return encodeBstr(value);
  }
  if (typeof value === 'boolean') {
    return encodeBool(value);
  }
  if (value instanceof Map) {
    return encodeMap(value.entries());
  }
  throw new OtaCborError(`unsupported canonical CBOR value: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// public decoder
// ---------------------------------------------------------------------------

function parse(bytes: Uint8Array, start: number): Cursor {
  if (start >= bytes.length) {
    throw new OtaCborError('truncated CBOR (empty input)');
  }
  const ini = bytes[start]!;
  const major = ini >> 5;
  if (major === 0) {
    const r = readLen(bytes, start, 'uint');
    return { value: r.value, next: r.next };
  }
  if (major === 2) {
    const r = readLen(bytes, start, 'bstr');
    need(bytes, r.next, r.value, 'bstr');
    return { value: bytes.slice(r.next, r.next + r.value), next: r.next + r.value };
  }
  if (major === 3) {
    const r = readLen(bytes, start, 'tstr');
    need(bytes, r.next, r.value, 'tstr');
    let text: string;
    try {
      text = decoder.decode(bytes.subarray(r.next, r.next + r.value));
    } catch {
      throw new OtaCborError('invalid UTF-8 in tstr');
    }
    return { value: text, next: r.next + r.value };
  }
  if (major === 5) {
    const countRes = readLen(bytes, start, 'map');
    let offset = countRes.next;
    const map = new Map<number, CborValue>();
    let prev = -1;
    for (let i = 0; i < countRes.value; i++) {
      const keyRes = parse(bytes, offset);
      if (typeof keyRes.value !== 'number') {
        throw new OtaCborError('map key is not an unsigned integer');
      }
      if (keyRes.value <= prev) {
        throw new OtaCborError('map keys must be strictly ascending (duplicate or unsorted)');
      }
      prev = keyRes.value;
      offset = keyRes.next;
      const valRes = parse(bytes, offset);
      map.set(keyRes.value, valRes.value);
      offset = valRes.next;
    }
    return { value: map, next: offset };
  }
  if (major === 7) {
    const b = ini & 0x1f;
    if (b === 0x14) {
      return { value: false, next: start + 1 };
    }
    if (b === 0x15) {
      return { value: true, next: start + 1 };
    }
    throw new OtaCborError('unsupported simple value (only booleans allowed)');
  }
  throw new OtaCborError(
    `unsupported CBOR major type ${major} (only uint/tstr/bstr/map/bool allowed)`,
  );
}

/**
 * Decode exactly one canonical CBOR item starting at byte `0`.
 *
 * @returns the decoded value and the number of bytes consumed. Trailing bytes
 *          are NOT rejected here so callers can parse a manifest followed by
 *          an image wrapper; use {@link decodeStrict} to reject trailing bytes.
 */
export function decodeCanonical(bytes: Uint8Array): { value: CborDecoded; consumed: number } {
  const r = parse(bytes, 0);
  return { value: r.value, consumed: r.next };
}

/** Decode a canonical CBOR item and reject any trailing bytes. */
export function decodeStrict(bytes: Uint8Array): CborDecoded {
  const r = parse(bytes, 0);
  if (r.next !== bytes.length) {
    throw new OtaCborError(`trailing bytes after canonical CBOR (${bytes.length - r.next})`);
  }
  return r.value;
}

/**
 * Decode a full (strict, no trailing) canonical CBOR item into a plain JS
 * object with uint-keyed number->string properties, for ergonomic access.
 */
export function mapField<K extends number>(map: CborMap, key: K): CborValue | undefined {
  return map.get(key);
}
