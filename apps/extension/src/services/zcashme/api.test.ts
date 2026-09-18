/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import {
  fetchDirectoryAll,
  lookupZcashMe,
  lookupZcashMeWithDecoys,
  parseZcashMeHandle,
  profileFromDirectory,
  stripUnverifiedSuffix,
} from './api';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const fakeFetch = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: f, calls };
};

describe('parseZcashMeHandle', () => {
  test('accepts the documented forms', () => {
    expect(parseZcashMeHandle('/alice')).toBe('alice');
    expect(parseZcashMeHandle('  /alice/ ')).toBe('alice');
    expect(parseZcashMeHandle('zcash.me/alice')).toBe('alice');
    expect(parseZcashMeHandle('https://zcash.me/alice')).toBe('alice');
    expect(parseZcashMeHandle('https://www.zcash.me/al_ice-1/')).toBe('al_ice-1');
    expect(parseZcashMeHandle('HTTPS://ZCASH.ME/Alice')).toBe('Alice');
  });

  test('rejects addresses, bare words, and junk', () => {
    expect(parseZcashMeHandle('u1abc')).toBeNull();
    expect(parseZcashMeHandle('alice')).toBeNull();
    expect(parseZcashMeHandle('@alice')).toBeNull();
    expect(parseZcashMeHandle('/alice/bob')).toBeNull();
    expect(parseZcashMeHandle('/al ice')).toBeNull();
    expect(parseZcashMeHandle('/')).toBeNull();
    expect(parseZcashMeHandle('https://evil.zcash.me.example/alice')).toBeNull();
  });
});

describe('stripUnverifiedSuffix', () => {
  test('drops the numeric row id the public endpoint appends to unverified names', () => {
    expect(stripUnverifiedSuffix('Kroy-249')).toBe('Kroy');
    expect(stripUnverifiedSuffix('alice')).toBe('alice');
    // only a trailing dash-digits run is a suffix; callers apply this to
    // unverified names only (see label.ts), a verified "web-3" keeps its name
    expect(stripUnverifiedSuffix('web-3')).toBe('web');
    expect(stripUnverifiedSuffix('web-dev')).toBe('web-dev');
  });
});

describe('lookupZcashMe', () => {
  const live = {
    username: 'yoshi',
    display_name: 'Yoshi',
    address: 'u1yoshi',
    address_verified: true,
    last_verified_at: '2026-01-01T00:00:00Z',
    bio: 'hi',
    location: 'Tokyo',
    profile_image_url: null,
    links: [{ platform: 'x', label: 'yoshi', url: 'https://x.com/yoshi' }],
  };

  test('hits the public endpoint without a key and maps the profile', async () => {
    const { fetch, calls } = fakeFetch(() => json(live));
    const res = await lookupZcashMe('Yoshi', { fetch });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.profile).toEqual({
      username: 'yoshi',
      displayName: 'Yoshi',
      address: 'u1yoshi',
      addressVerified: true,
      bio: 'hi',
      location: 'Tokyo',
      profileImageUrl: null,
      links: [{ platform: 'x', label: 'yoshi', url: 'https://x.com/yoshi' }],
    });
    expect(calls[0]!.url).toBe('https://zcash.me/api/lookup/Yoshi');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBeUndefined();
  });

  test('url-encodes the username', async () => {
    const { fetch, calls } = fakeFetch(() => json({ error: 'not_found' }, 404));
    await lookupZcashMe('a-b_c', { fetch });
    expect(calls[0]!.url).toBe('https://zcash.me/api/lookup/a-b_c');
  });

  test('refuses an invalid username locally, without a request', async () => {
    const { fetch, calls } = fakeFetch(() => json(live));
    const res = await lookupZcashMe('not a name', { fetch });
    expect(res).toMatchObject({ ok: false, error: 'invalid_username' });
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['not_found', 404, 'not_found'],
    ['no_address', 404, 'no_address'],
    ['lookup_failed', 500, 'lookup_failed'],
    ['service_unavailable', 503, 'service_unavailable'],
    ['unauthorized', 401, 'unauthorized'],
  ])('maps error code %s', async (code, status, expected) => {
    const { fetch } = fakeFetch(() => json({ error: code }, status));
    const res = await lookupZcashMe('alice', { fetch });
    expect(res).toMatchObject({ ok: false, error: expected });
  });

  test('falls back to the http status when the body has no error code', async () => {
    const { fetch } = fakeFetch(() => new Response('gateway down', { status: 503 }));
    const res = await lookupZcashMe('alice', { fetch });
    expect(res).toMatchObject({ ok: false, error: 'service_unavailable' });
  });

  test('reports a network failure instead of throwing', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const res = await lookupZcashMe('alice', { fetch });
    expect(res).toMatchObject({ ok: false, error: 'network' });
  });

  test('keeps the unverified suffix and flag as returned', async () => {
    const { fetch } = fakeFetch(() =>
      json({ ...live, username: 'Kroy-249', address_verified: false, links: [] }),
    );
    const res = await lookupZcashMe('kroy', { fetch });
    expect(res.ok && res.profile.username).toBe('Kroy-249');
    expect(res.ok && res.profile.addressVerified).toBe(false);
  });

  test('rejects a malformed 200 body', async () => {
    const { fetch } = fakeFetch(() => json({ username: 'x' }));
    const res = await lookupZcashMe('x', { fetch });
    expect(res).toMatchObject({ ok: false, error: 'lookup_failed' });
  });
});

describe('profileFromDirectory', () => {
  test('drops rows without an address and keeps only verified links', () => {
    expect(
      profileFromDirectory({
        username: 'ghost',
        display_name: null,
        profile_image_url: null,
        bio: null,
        nearest_city_name: null,
        address: null,
        address_verified: false,
        verified_at: null,
      }),
    ).toBeNull();
    const p = profileFromDirectory({
      username: 'cobra',
      display_name: 'Cobra',
      profile_image_url: 'https://img',
      bio: 'b',
      nearest_city_name: 'Denver',
      address: 'u1cobra',
      address_verified: true,
      verified_at: '2025-10-23T10:58:54Z',
      authenticated_links: [
        { id: 1, label: 'cobra.example.com', url: 'https://cobra.example.com', is_verified: true },
      ],
      unauthenticated_links: [
        { id: 2, label: 'cobracrypto', url: 'https://x.com/cobracrypto', is_verified: false },
      ],
    });
    expect(p).toMatchObject({
      username: 'cobra',
      address: 'u1cobra',
      location: 'Denver',
      links: [{ platform: 'cobra', url: 'https://cobra.example.com' }],
    });
  });
});

describe('fetchDirectoryAll', () => {
  const row = (i: number) => ({
    username: `user${i}`,
    display_name: null,
    profile_image_url: null,
    bio: null,
    nearest_city_name: null,
    address: `u1addr${i}`,
    address_verified: i % 2 === 0,
    verified_at: null,
    authenticated_links: [],
    unauthenticated_links: [],
  });

  test('refuses to run without a key', async () => {
    await expect(fetchDirectoryAll({ fetch: fakeFetch(() => json({})).fetch })).rejects.toThrow(
      /api key/,
    );
  });

  test('sends the key, follows cursors, and concatenates pages', async () => {
    const { fetch, calls } = fakeFetch(url => {
      const u = new URL(url);
      expect(u.searchParams.get('limit')).toBe('100');
      const cursor = u.searchParams.get('cursor');
      if (!cursor) {
        return json({ results: [row(1), row(2)], next_cursor: 'c2' });
      }
      if (cursor === 'c2') {
        return json({ results: [row(3)], next_cursor: null });
      }
      throw new Error(`unexpected cursor ${cursor}`);
    });
    const progress: number[] = [];
    const profiles = await fetchDirectoryAll({
      fetch,
      apiKey: 'k',
      onProgress: p => progress.push(p.profiles),
    });
    expect(profiles.map(p => p.username)).toEqual(['user1', 'user2', 'user3']);
    expect(progress).toEqual([2, 3]);
    for (const c of calls) {
      expect((c.init?.headers as Record<string, string>)['X-API-Key']).toBe('k');
    }
  });

  test('throws on an unauthorized page so a partial directory is never saved', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'unauthorized' }, 401));
    await expect(fetchDirectoryAll({ fetch, apiKey: 'bad' })).rejects.toThrow(/api key/);
  });
});

describe('lookupZcashMeWithDecoys', () => {
  const hit = (name: string) =>
    json({
      username: name,
      display_name: null,
      address: `u1${name}`,
      address_verified: true,
    });

  test('queries the real name and every decoy, returns only the real result', async () => {
    const { fetch, calls } = fakeFetch(url => {
      const name = decodeURIComponent(url.split('/').pop()!);
      return name === 'ghost' ? json({ error: 'not_found' }, 404) : hit(name);
    });
    const res = await lookupZcashMeWithDecoys('alice', ['bob', 'carol'], { fetch });
    expect(res.ok && res.profile.username).toBe('alice');
    const names = calls.map(c => decodeURIComponent(c.url.split('/').pop()!)).sort();
    expect(names).toEqual(['alice', 'bob', 'carol']);
  });

  test('a failed decoy never masks the real result', async () => {
    const { fetch } = fakeFetch(url =>
      url.endsWith('/alice') ? hit('alice') : json({ error: 'service_unavailable' }, 503),
    );
    const res = await lookupZcashMeWithDecoys('alice', ['dead1', 'dead2'], { fetch });
    expect(res.ok && res.profile.username).toBe('alice');
  });

  test('spaces launches on the given cadence via the injected sleep', async () => {
    const sleeps: number[] = [];
    const { fetch } = fakeFetch(url => hit(decodeURIComponent(url.split('/').pop()!)));
    await lookupZcashMeWithDecoys('alice', ['bob', 'carol'], {
      fetch,
      spacingMs: 100,
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    // one gap between each of the 3 launches, i.e. 2 sleeps, each >= base
    expect(sleeps).toHaveLength(2);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(100);
    }
  });

  test('de-dupes decoys that collide with each other', async () => {
    const { fetch, calls } = fakeFetch(url => hit(decodeURIComponent(url.split('/').pop()!)));
    await lookupZcashMeWithDecoys('alice', ['bob', 'bob'], { fetch });
    const names = calls.map(c => decodeURIComponent(c.url.split('/').pop()!)).sort();
    expect(names).toEqual(['alice', 'bob']);
  });
});
