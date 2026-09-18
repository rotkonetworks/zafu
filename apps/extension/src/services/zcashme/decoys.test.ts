/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { MAX_DECOYS, decoyCountRange, pickDecoyCount, pickDecoys } from './decoys';
import { buildDirectoryIndex, type DirectorySnapshot } from './directory';
import type { ZcashMeProfile } from './api';

const prof = (username: string): ZcashMeProfile => ({
  username,
  displayName: null,
  address: `u1${username}`,
  addressVerified: false,
  bio: null,
  location: null,
  profileImageUrl: null,
  links: [],
});

const index = (names: string[]) =>
  buildDirectoryIndex({
    version: 1,
    fetchedAt: 0,
    source: 'test',
    profiles: names.map(prof),
  } as DirectorySnapshot);

describe('pickDecoys', () => {
  const idx = index(['alice', 'bob', 'carol', 'dave', 'erin', 'frank']);

  test('never includes the real name (case-insensitive)', () => {
    for (let i = 0; i < 50; i++) {
      const d = pickDecoys(idx, 'ALICE', 4);
      expect(d.map(x => x.toLowerCase())).not.toContain('alice');
    }
  });

  test('returns the requested count when the pool is large enough, de-duped', () => {
    const d = pickDecoys(idx, 'alice', 4);
    expect(d).toHaveLength(4);
    expect(new Set(d).size).toBe(4);
  });

  test('returns fewer than requested when the pool is small', () => {
    const small = index(['alice', 'bob']);
    expect(pickDecoys(small, 'alice', 4)).toEqual(['bob']);
    expect(pickDecoys(index(['alice']), 'alice', 4)).toEqual([]);
  });

  test('count 0 yields no decoys and MAX_DECOYS is the ceiling', () => {
    expect(pickDecoys(idx, 'alice', 0)).toEqual([]);
    expect(pickDecoys(idx, 'alice', 999).length).toBeLessThanOrEqual(MAX_DECOYS);
  });
});

describe('decoyCountRange / pickDecoyCount', () => {
  test('target 0 disables cover', () => {
    expect(decoyCountRange(0)).toEqual({ min: 0, max: 0 });
    expect(pickDecoyCount(0)).toBe(0);
  });

  test('range is a band around the target, clamped to [1, MAX_DECOYS]', () => {
    expect(decoyCountRange(4)).toEqual({ min: 2, max: 6 });
    const hi = decoyCountRange(MAX_DECOYS);
    expect(hi.max).toBe(MAX_DECOYS);
    expect(hi.min).toBeGreaterThanOrEqual(1);
  });

  test('picked count always lands within the range', () => {
    for (const target of [1, 2, 4, 8]) {
      const { min, max } = decoyCountRange(target);
      for (const u of [0, 0.25, 0.5, 0.75, 0.999]) {
        const n = pickDecoyCount(target, () => u);
        expect(n).toBeGreaterThanOrEqual(min);
        expect(n).toBeLessThanOrEqual(max);
      }
    }
  });

  test('varies across draws so the burst size is not constant', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickDecoyCount(4));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
