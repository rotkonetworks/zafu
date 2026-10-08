import { describe, expect, test } from 'vitest';
import {
  eachField,
  int32,
  readBytes,
  readTag,
  readVarint,
  readVarintNumber,
  skipValue,
} from './proto-reader';

const bytes = (...b: number[]) => Uint8Array.from(b);

/** encode an unsigned varint, for building fixtures */
const varint = (n: bigint): number[] => {
  const out: number[] = [];
  while (n > 0x7fn) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
};

const fields = (buf: Uint8Array) => {
  const out: [number, number, bigint | Uint8Array][] = [];
  eachField(buf, (f, w, v) => out.push([f, w, v]));
  return out;
};

describe('readVarint', () => {
  test('one and several bytes', () => {
    expect(readVarint(bytes(0), 0)).toEqual([0n, 1]);
    expect(readVarint(bytes(0x7f), 0)).toEqual([127n, 1]);
    expect(readVarint(bytes(0xac, 0x02), 0)).toEqual([300n, 2]);
    expect(readVarint(bytes(9, 0xac, 0x02), 1)).toEqual([300n, 3]);
  });

  test('64-bit values keep every bit', () => {
    for (const n of [2n ** 31n, 2n ** 32n + 1n, 2n ** 53n + 1n, 2n ** 64n - 1n]) {
      const enc = varint(n);
      expect(readVarint(Uint8Array.from(enc), 0)).toEqual([n, enc.length]);
    }
  });

  test('truncated', () => {
    expect(readVarint(bytes(), 0)).toBeUndefined();
    expect(readVarint(bytes(0x80), 0)).toBeUndefined();
    expect(readVarint(bytes(0xff, 0xff), 0)).toBeUndefined();
    expect(readVarint(bytes(1), 1)).toBeUndefined();
  });

  test('oversized: more than 10 bytes, or past 64 bits', () => {
    expect(readVarint(Uint8Array.from([...Array<number>(10).fill(0x80), 0]), 0)).toBeUndefined();
    expect(readVarint(Uint8Array.from([...Array<number>(9).fill(0xff), 0x02]), 0)).toBeUndefined();
    expect(readVarint(Uint8Array.from(Array<number>(64).fill(0xff)), 0)).toBeUndefined();
  });
});

describe('readVarintNumber', () => {
  test('values past int32 do not wrap', () => {
    for (const n of [2 ** 31, 2 ** 32 + 5, 4_000_000_000, Number.MAX_SAFE_INTEGER]) {
      const enc = varint(BigInt(n));
      expect(readVarintNumber(Uint8Array.from(enc), 0)).toEqual([n, enc.length]);
    }
  });

  test('past 2^53 is refused rather than rounded', () => {
    expect(readVarintNumber(Uint8Array.from(varint(2n ** 53n)), 0)).toBeUndefined();
    expect(readVarintNumber(Uint8Array.from(varint(2n ** 64n - 1n)), 0)).toBeUndefined();
  });

  test('truncated and oversized', () => {
    expect(readVarintNumber(bytes(0x80, 0x80), 0)).toBeUndefined();
    expect(
      readVarintNumber(Uint8Array.from([...Array<number>(10).fill(0x80), 0]), 0),
    ).toBeUndefined();
  });
});

describe('int32', () => {
  test('negatives arrive as ten-byte varints', () => {
    const neg = readVarint(Uint8Array.from(varint(2n ** 64n - 26n)), 0)!;
    expect(neg[1]).toBe(10);
    expect(int32(neg[0])).toBe(-26);
    expect(int32(2n ** 64n - 1n)).toBe(-1);
    expect(int32(0n)).toBe(0);
    expect(int32(2n ** 31n - 1n)).toBe(2 ** 31 - 1);
  });
});

describe('readTag', () => {
  test('one-byte tags', () => {
    expect(readTag(bytes(0x08), 0)).toEqual({ field: 1, wire: 0, next: 1 });
    expect(readTag(bytes(0x7a), 0)).toEqual({ field: 15, wire: 2, next: 1 });
  });

  test('fields past 15 take two bytes', () => {
    // field 16, wire 2: key 130 = 0x82 0x01
    expect(readTag(bytes(0x82, 0x01), 0)).toEqual({ field: 16, wire: 2, next: 2 });
    // field 1000, wire 0: key 8000
    expect(readTag(Uint8Array.from(varint(8000n)), 0)).toEqual({ field: 1000, wire: 0, next: 2 });
  });

  test('truncated', () => {
    expect(readTag(bytes(0x82), 0)).toBeUndefined();
  });
});

describe('readBytes', () => {
  test('a view of the bytes', () => {
    const buf = bytes(3, 1, 2, 3, 9);
    const [v, next] = readBytes(buf, 0)!;
    expect(v).toEqual(bytes(1, 2, 3));
    expect(next).toBe(4);
    expect(v.buffer).toBe(buf.buffer);
  });

  test('empty', () => {
    expect(readBytes(bytes(0), 0)).toEqual([bytes(), 1]);
  });

  test('a length past the end is refused', () => {
    expect(readBytes(bytes(4, 1, 2, 3), 0)).toBeUndefined();
    expect(readBytes(bytes(0x80), 0)).toBeUndefined();
    // a length past int32 (where `<<` would wrap negative) is just too long
    expect(readBytes(Uint8Array.from([...varint(2n ** 31n), 1, 2]), 0)).toBeUndefined();
    expect(readBytes(Uint8Array.from(varint(2n ** 60n)), 0)).toBeUndefined();
  });
});

describe('skipValue', () => {
  test('each wire type', () => {
    expect(skipValue(bytes(0xac, 0x02), 0, 0)).toBe(2);
    expect(skipValue(new Uint8Array(8), 0, 1)).toBe(8);
    expect(skipValue(bytes(2, 1, 2), 0, 2)).toBe(3);
    expect(skipValue(new Uint8Array(4), 0, 5)).toBe(4);
  });

  test('cut short', () => {
    expect(skipValue(new Uint8Array(7), 0, 1)).toBeUndefined();
    expect(skipValue(new Uint8Array(3), 0, 5)).toBeUndefined();
    expect(skipValue(bytes(0x80), 0, 0)).toBeUndefined();
    expect(skipValue(bytes(5, 1), 0, 2)).toBeUndefined();
  });

  test('groups and unknown wire types', () => {
    for (const w of [3, 4, 6, 7]) {
      expect(skipValue(new Uint8Array(16), 0, w)).toBeUndefined();
    }
  });
});

describe('eachField', () => {
  test('varints as bigint, bytes as views, in order', () => {
    const buf = Uint8Array.from([0x08, ...varint(2n ** 40n), 0x12, 2, 0xaa, 0xbb, 0x08, 1]);
    expect(fields(buf)).toEqual([
      [1, 0, 2n ** 40n],
      [2, 2, bytes(0xaa, 0xbb)],
      [1, 0, 1n],
    ]);
  });

  test('unknown fixed32/fixed64 fields are skipped', () => {
    const buf = Uint8Array.from([
      0x09, // field 1, fixed64
      ...new Uint8Array(8),
      0x15, // field 2, fixed32
      ...new Uint8Array(4),
      0x18, // field 3, varint
      7,
    ]);
    expect(fields(buf)).toEqual([[3, 0, 7n]]);
  });

  test('fields past 15', () => {
    const buf = Uint8Array.from([0x82, 0x01, 1, 0x41, 0xf0, 0x01, 5, 0x08, 2]);
    expect(fields(buf)).toEqual([
      [16, 2, bytes(0x41)],
      [30, 0, 5n],
      [1, 0, 2n],
    ]);
  });

  test('malformed input stops, keeping what came before', () => {
    // truncated length-delimited
    expect(fields(bytes(0x08, 1, 0x12, 5, 1, 2))).toEqual([[1, 0, 1n]]);
    // truncated varint value
    expect(fields(bytes(0x08, 1, 0x10, 0x80))).toEqual([[1, 0, 1n]]);
    // truncated tag
    expect(fields(bytes(0x08, 1, 0x82))).toEqual([[1, 0, 1n]]);
    // group wire type
    expect(fields(bytes(0x08, 1, 0x0b, 0x08, 2))).toEqual([[1, 0, 1n]]);
    // truncated fixed64
    expect(fields(bytes(0x08, 1, 0x09, 1, 2, 3))).toEqual([[1, 0, 1n]]);
    // oversized varint
    expect(fields(Uint8Array.from([0x08, ...Array<number>(11).fill(0xff), 0]))).toEqual([]);
  });

  test('ends on any input', () => {
    // a deterministic spread of junk: each call must return, never loop or throw
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    for (let n = 0; n < 2000; n++) {
      const buf = Uint8Array.from({ length: n % 64 }, rand);
      expect(() => eachField(buf, () => undefined)).not.toThrow();
    }
  });
});
