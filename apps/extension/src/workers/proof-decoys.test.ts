/**
 * Tests for the proof-query decoy padding.
 *
 * These pin the two properties the privacy claim actually rests on:
 * stability (the same query re-sends byte-identically, so the server cannot
 * intersect sessions) and field-validity (decoy nullifiers are indis-
 * tinguishable from real ones as values). If either regresses, the padding
 * stops being padding and becomes noise that the server can filter out.
 */

import { describe, expect, it } from 'vitest';
import {
  decoyNullifiersFor,
  padCommitmentQuery,
  padNullifierQuery,
  seededShuffle,
  CommitmentReservoir,
  type CommitmentItem,
} from './proof-decoys';

const PALLAS_BASE_MODULUS = 0x40000000000000000000000000000000224698fc094cf91b992d30ed00000001n;

const leToBigInt = (b: Uint8Array): bigint => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(b[i]!);
  }
  return v;
};

const seed = new Uint8Array(32).fill(7);
const otherSeed = new Uint8Array(32).fill(9);

const nf = (n: number): Uint8Array => {
  const b = new Uint8Array(32);
  b[0] = n;
  b[31] = 0x0a; // keep well under the modulus
  return b;
};

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

describe('decoyNullifiersFor', () => {
  it('produces valid Pallas base field elements', () => {
    for (let i = 0; i < 50; i++) {
      for (const d of decoyNullifiersFor(seed, nf(i), 2)) {
        expect(d.length).toBe(32);
        expect(leToBigInt(d)).toBeLessThan(PALLAS_BASE_MODULUS);
      }
    }
  });

  it('is deterministic for a given seed and nullifier', () => {
    const a = decoyNullifiersFor(seed, nf(1), 2).map(hex);
    const b = decoyNullifiersFor(seed, nf(1), 2).map(hex);
    expect(a).toEqual(b);
  });

  it('differs across seeds and across nullifiers', () => {
    expect(decoyNullifiersFor(seed, nf(1), 2).map(hex)).not.toEqual(
      decoyNullifiersFor(otherSeed, nf(1), 2).map(hex),
    );
    expect(decoyNullifiersFor(seed, nf(1), 2).map(hex)).not.toEqual(
      decoyNullifiersFor(seed, nf(2), 2).map(hex),
    );
  });
});

describe('padNullifierQuery', () => {
  it('expands the query by the decoy ratio and keeps realHex real-only', () => {
    const real = [nf(1), nf(2), nf(3)];
    const { query, realHex } = padNullifierQuery(real, seed, 2);
    expect(query.length).toBe(9);
    expect(realHex.size).toBe(3);
    for (const r of real) {
      expect(realHex.has(hex(r))).toBe(true);
    }
    // every real nullifier still present in the padded query
    const q = new Set(query.map(hex));
    for (const r of real) {
      expect(q.has(hex(r))).toBe(true);
    }
  });

  it('is STABLE — repeating the query is byte-identical', () => {
    const real = [nf(1), nf(2), nf(3)];
    const a = padNullifierQuery(real, seed, 2).query.map(hex);
    const b = padNullifierQuery(real, seed, 2).query.map(hex);
    expect(a).toEqual(b);
  });

  it('does not leave the real items in their original positions', () => {
    // if decoys were merely appended, the first N entries would be the real
    // set and the padding would be worthless.
    const real = Array.from({ length: 8 }, (_, i) => nf(i + 1));
    const { query } = padNullifierQuery(real, seed, 2);
    const firstN = query.slice(0, real.length).map(hex);
    expect(firstN).not.toEqual(real.map(hex));
  });

  it('passes through unpadded when no seed is available', () => {
    const real = [nf(1), nf(2)];
    const { query } = padNullifierQuery(real, null, 2);
    expect(query.map(hex)).toEqual(real.map(hex));
  });

  it('handles an empty real set', () => {
    expect(padNullifierQuery([], seed, 2).query).toEqual([]);
  });
});

describe('padCommitmentQuery', () => {
  const item = (n: number): CommitmentItem => {
    const cmx = new Uint8Array(32);
    cmx[0] = n;
    cmx[1] = 0xbb;
    return { cmx, position: n * 10 };
  };

  it('pads from the observed pool and keeps cmx/position aligned', () => {
    const real = [item(1), item(2)];
    const pool = Array.from({ length: 40 }, (_, i) => item(100 + i));
    const out = padCommitmentQuery(real, pool, seed, 2);

    expect(out.cmxs.length).toBe(6);
    expect(out.positions.length).toBe(6);
    expect(out.realHex.size).toBe(2);

    // each emitted cmx must still carry its own position
    const byHex = new Map([...real, ...pool].map(i => [hex(i.cmx), i.position]));
    out.cmxs.forEach((c, idx) => {
      expect(out.positions[idx]).toBe(byHex.get(hex(c)));
    });
  });

  it('is stable for the same pool', () => {
    const real = [item(1), item(2)];
    const pool = Array.from({ length: 40 }, (_, i) => item(100 + i));
    const a = padCommitmentQuery(real, pool, seed, 2).cmxs.map(hex);
    const b = padCommitmentQuery(real, pool, seed, 2).cmxs.map(hex);
    expect(a).toEqual(b);
  });

  it('degrades gracefully when the pool is empty', () => {
    const real = [item(1), item(2)];
    const out = padCommitmentQuery(real, [], seed, 2);
    expect(out.cmxs.length).toBe(2);
    expect(out.realHex.size).toBe(2);
  });

  it('never emits a real cmx as a decoy', () => {
    const real = [item(1), item(2)];
    // pool deliberately contains the real items too
    const pool = [...real, ...Array.from({ length: 20 }, (_, i) => item(100 + i))];
    const out = padCommitmentQuery(real, pool, seed, 2);
    const counts = new Map<string, number>();
    for (const c of out.cmxs) {
      counts.set(hex(c), (counts.get(hex(c)) ?? 0) + 1);
    }
    // no duplicates — a repeated cmx would flag it as the real one
    for (const n of counts.values()) {
      expect(n).toBe(1);
    }
  });
});

describe('seededShuffle', () => {
  it('is a permutation', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = seededShuffle(items, seed, 'test');
    expect(out.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it('is deterministic and seed-dependent', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(seededShuffle(items, seed, 'test')).toEqual(seededShuffle(items, seed, 'test'));
    expect(seededShuffle(items, seed, 'test')).not.toEqual(seededShuffle(items, otherSeed, 'test'));
  });
});

describe('CommitmentReservoir', () => {
  it('bounds its size at the cap', () => {
    const r = new CommitmentReservoir(10);
    for (let i = 0; i < 1000; i++) {
      r.offer(new Uint8Array(32).fill(i % 251), i);
    }
    expect(r.size).toBe(10);
  });

  it('retains everything below the cap', () => {
    const r = new CommitmentReservoir(10);
    for (let i = 0; i < 4; i++) {
      r.offer(new Uint8Array(32).fill(i), i);
    }
    expect(r.size).toBe(4);
    expect(r.snapshot().map(i => i.position)).toEqual([0, 1, 2, 3]);
  });
});
