/**
 * A small protobuf wire-format reader, for the hand-decoded messages the
 * zcash light clients read (zidecar, lightwalletd).
 *
 * Every read is bounds-checked and returns `undefined` on malformed input
 * instead of throwing: a truncated or oversized varint, a length past the end
 * of the buffer, an unknown wire type. Nothing here reads past `buf.length`,
 * and every read advances, so a loop over it always ends.
 */

/** wire types: varint, fixed64, length-delimited, fixed32 */
export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

/** a protobuf varint is at most 10 bytes (64 bits, 7 per byte) */
const MAX_VARINT_BYTES = 10;
const U64_MAX = (1n << 64n) - 1n;

/**
 * An unsigned 64-bit varint at `pos`: [value, next pos], or undefined if it
 * runs off the end, is longer than 10 bytes, or does not fit in 64 bits.
 */
export const readVarint = (buf: Uint8Array, pos: number): [bigint, number] | undefined => {
  let v = 0n;
  for (let i = 0; i < MAX_VARINT_BYTES && pos < buf.length; i++) {
    const b = buf[pos++]!;
    v |= BigInt(b & 0x7f) << BigInt(7 * i);
    if (!(b & 0x80)) {
      return v <= U64_MAX ? [v, pos] : undefined;
    }
  }
  return undefined;
};

/**
 * A varint at `pos` as a Number: [value, next pos], or undefined if it is
 * malformed (as readVarint) or past Number.MAX_SAFE_INTEGER. For lengths,
 * heights, counts; use readVarint for 64-bit amounts.
 */
export const readVarintNumber = (buf: Uint8Array, pos: number): [number, number] | undefined => {
  let v = 0;
  for (let i = 0; i < MAX_VARINT_BYTES && pos < buf.length; i++) {
    const b = buf[pos++]!;
    // multiply, not shift: `<<` is int32 and wraps negative at 2^31
    v += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) {
      return Number.isSafeInteger(v) ? [v, pos] : undefined;
    }
  }
  return undefined;
};

export interface Tag {
  field: number;
  wire: number;
  /** the position after the tag */
  next: number;
}

/** a field tag (a varint: fields past 15 take two bytes) */
export const readTag = (buf: Uint8Array, pos: number): Tag | undefined => {
  const key = readVarintNumber(buf, pos);
  if (!key) {
    return undefined;
  }
  return { field: Math.floor(key[0] / 8), wire: key[0] % 8, next: key[1] };
};

/**
 * A length-delimited value at `pos` (just after its tag): [a view of its
 * bytes, next pos], or undefined if the length is malformed or runs past the
 * end. The bytes are a subarray, not a copy.
 */
export const readBytes = (buf: Uint8Array, pos: number): [Uint8Array, number] | undefined => {
  const len = readVarintNumber(buf, pos);
  if (!len) {
    return undefined;
  }
  const end = len[1] + len[0];
  if (end > buf.length) {
    return undefined;
  }
  return [buf.subarray(len[1], end), end];
};

/**
 * Skip the value of a field of `wire` type at `pos`: the next pos, or
 * undefined if it is cut short or the wire type is not 0, 1, 2 or 5
 * (groups, 3 and 4, are not supported).
 */
export const skipValue = (buf: Uint8Array, pos: number, wire: number): number | undefined => {
  switch (wire) {
    case WIRE_VARINT:
      return readVarint(buf, pos)?.[1];
    case WIRE_FIXED64:
      return pos + 8 <= buf.length ? pos + 8 : undefined;
    case WIRE_LEN:
      return readBytes(buf, pos)?.[1];
    case WIRE_FIXED32:
      return pos + 4 <= buf.length ? pos + 4 : undefined;
    default:
      return undefined;
  }
};

/**
 * Walk the top-level fields of a message. `fn` gets varints (wire 0) as
 * bigint and length-delimited fields (wire 2) as a subarray view; fixed32 and
 * fixed64 fields are skipped. Stops at the first malformed field, keeping
 * what was read before it.
 */
export const eachField = (
  buf: Uint8Array,
  fn: (field: number, wire: number, val: bigint | Uint8Array) => void,
): void => {
  let pos = 0;
  while (pos < buf.length) {
    const tag = readTag(buf, pos);
    if (!tag) {
      return;
    }
    const { field, wire } = tag;
    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, tag.next);
      if (!v) {
        return;
      }
      fn(field, wire, v[0]);
      pos = v[1];
    } else if (wire === WIRE_LEN) {
      const v = readBytes(buf, tag.next);
      if (!v) {
        return;
      }
      fn(field, wire, v[0]);
      pos = v[1];
    } else {
      const next = skipValue(buf, tag.next, wire);
      if (next === undefined) {
        return;
      }
      pos = next;
    }
  }
};
