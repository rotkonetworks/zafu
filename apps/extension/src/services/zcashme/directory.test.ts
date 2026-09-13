/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import {
  buildDirectoryIndex,
  parseDirectorySnapshot,
  searchDirectory,
  type DirectorySnapshot,
} from './directory';
import type { ZcashMeProfile } from './api';

const p = (
  over: Partial<ZcashMeProfile> & { username: string; address: string },
): ZcashMeProfile => ({
  displayName: null,
  addressVerified: false,
  bio: null,
  location: null,
  profileImageUrl: null,
  links: [],
  ...over,
});

const snap = (profiles: ZcashMeProfile[]): DirectorySnapshot => ({
  version: 1,
  fetchedAt: 0,
  source: 'test',
  profiles,
});

describe('buildDirectoryIndex', () => {
  test('keys names case-insensitively and addresses exactly', () => {
    const idx = buildDirectoryIndex(snap([p({ username: 'Alice', address: 'u1a' })]));
    expect(idx.byName.get('alice')?.address).toBe('u1a');
    expect(idx.byName.get('Alice')).toBeUndefined();
    expect(idx.byAddress.get('u1a')?.username).toBe('Alice');
  });

  test('a verified claim beats an unverified one for the same address', () => {
    const idx = buildDirectoryIndex(
      snap([
        p({ username: 'squatter', address: 'u1x' }),
        p({ username: 'owner', address: 'u1x', addressVerified: true }),
        p({ username: 'later', address: 'u1x', addressVerified: true }),
      ]),
    );
    expect(idx.byAddress.get('u1x')?.username).toBe('owner');
  });
});

describe('searchDirectory', () => {
  const idx = buildDirectoryIndex(
    snap([
      p({ username: 'bob', address: 'u1b' }),
      p({ username: 'alice', address: 'u1a', addressVerified: true }),
      p({ username: 'malice', address: 'u1m' }),
      p({ username: 'zed', address: 'u1z', displayName: 'Alistair' }),
      p({ username: 'alfred', address: 'u1f' }),
    ]),
  );

  test('ranks username prefix, then contains, then display name', () => {
    expect(searchDirectory(idx, 'ali', 10).map(x => x.username)).toEqual([
      'alice',
      'malice',
      'zed',
    ]);
  });

  test('verified sorts ahead within a tier, then alphabetical', () => {
    expect(searchDirectory(idx, 'al', 10).map(x => x.username)).toEqual([
      'alice',
      'alfred',
      'malice',
      'zed',
    ]);
  });

  test('respects the limit and ignores blank queries', () => {
    expect(searchDirectory(idx, 'al', 1)).toHaveLength(1);
    expect(searchDirectory(idx, '  ', 10)).toEqual([]);
  });
});

describe('parseDirectorySnapshot', () => {
  test('accepts a well-formed snapshot and drops malformed rows', () => {
    const s = parseDirectorySnapshot(
      {
        version: 1,
        fetchedAt: 5,
        profiles: [p({ username: 'a', address: 'u1a' }), { username: 'broken' }, 42],
      },
      'https://mirror',
    );
    expect(s.profiles).toHaveLength(1);
    expect(s.source).toBe('https://mirror');
    expect(s.fetchedAt).toBe(5);
  });

  test('rejects other versions and non-objects', () => {
    expect(() => parseDirectorySnapshot({ version: 2, profiles: [] }, 'x')).toThrow(/version/);
    expect(() => parseDirectorySnapshot('nope', 'x')).toThrow();
    expect(() => parseDirectorySnapshot({ version: 1 }, 'x')).toThrow(/profiles/);
  });
});
