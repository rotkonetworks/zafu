import { describe, expect, test } from 'vitest';
import { derivePassword, normalizeOrigin, normalizeOriginV1, DEFAULT_IDENTITY } from './identity';
import { schemeOf } from './password-logins';

// harness test phrase (zero funds, never holds anything real)
const SEED = Array(23).fill('abandon').concat(['art']).join(' ');
const B85_CHARS = /^[0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]*$/;

describe('derivePassword', () => {
  // fixed vector - pins the output after fixing the sign bug below. the
  // first 5-char group was never affected by that bug (see next test), so
  // this also proves the fix did not change any password that was ever a
  // real, usable password.
  test('fixed vector, v1: forum.z.cash / tommi / 32 / rotation 0', () => {
    // the password a v1 saved login has always had; it must never change
    expect(derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', 32, 0, 1)).toBe(
      '!*5mO4D&0lFGpti8Oc~4X{5I&7Lv2^@p',
    );
  });

  test('same inputs always give the same password', () => {
    const a = derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', 32, 0);
    const b = derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', 32, 0);
    expect(a).toBe(b);
  });

  test('rotation changes the password, same prefix logic applies per group', () => {
    const rot0 = derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', 32, 0);
    const rot1 = derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', 32, 1);
    expect(rot1).not.toBe(rot0);
  });

  test('normalizeOrigin folds protocol, subdomain and path to the same password', () => {
    const bare = derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', 32, 0);
    const dressed = derivePassword(
      SEED,
      DEFAULT_IDENTITY,
      'https://www.forum.z.cash/path?x=1',
      'tommi',
      32,
      0,
    );
    expect(dressed).toBe(bare);
    expect(normalizeOrigin('https://www.forum.z.cash/path?x=1')).toBe('forum.z.cash');
  });

  test.each([16, 24, 32, 40] as const)('length %i is honored exactly', len => {
    const pw = derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', len, 0);
    expect(pw).toHaveLength(len);
    expect(pw).toMatch(B85_CHARS);
    expect(pw).not.toContain('undefined');
  });

  // the seed feeding the encoder is 32 bytes (8 groups of 4), and each group
  // contributes at most 5 base85 characters, so 40 is the real ceiling -
  // asking for more silently truncates. the UI must never offer a length
  // past this.
  test('length beyond the 40-char ceiling truncates instead of erroring', () => {
    const pw = derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', 48, 0);
    expect(pw).toHaveLength(40);
  });

  // the regression this guards: a byte >= 0x80 made the 32-bit accumulator
  // negative, so `val % 85` was negative and indexing B85 with it returned
  // undefined - `result += undefined` baked the literal word "undefined"
  // into the password. Sweeping many usernames would have hit this before
  // the `>>> 0` fix; none of today's outputs may contain it.
  test('no derived password ever contains the literal word "undefined"', () => {
    for (let i = 0; i < 200; i++) {
      const pw = derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', `user${i}`, 32, 0);
      expect(pw).not.toContain('undefined');
    }
  });
});

describe('password schemes', () => {
  const pw = (site: string, user: string, index = 0, scheme: 1 | 2 = 2) =>
    derivePassword(SEED, DEFAULT_IDENTITY, site, user, 32, index, scheme);

  test('v2 keeps the registrable domain: unrelated sites never share a password', () => {
    for (const [a, b] of [
      ['mail.com', 'my.com'],
      ['app.com', 'id.com'],
      ['mail.ru', 'id.ru'],
      ['id.me', 'my.me'],
    ] as const) {
      expect(pw(a, 'me@x.org')).not.toBe(pw(b, 'me@x.org'));
    }
    // v1 is the bug this fixes: all four became the bare suffix
    expect(normalizeOriginV1('mail.com')).toBe('com');
    expect(pw('mail.com', 'me@x.org', 0, 1)).toBe(pw('my.com', 'me@x.org', 0, 1));
  });

  test('v2 normalization', () => {
    expect(normalizeOrigin('https://www.forum.z.cash/path?x=1')).toBe('forum.z.cash');
    expect(normalizeOrigin('login.github.com')).toBe('github.com');
    expect(normalizeOrigin('mail.com')).toBe('mail.com');
    expect(normalizeOrigin('mail.ru')).toBe('mail.ru');
    expect(normalizeOrigin('id.me')).toBe('id.me');
    expect(normalizeOrigin('my.co.uk')).toBe('my.co.uk');
    expect(normalizeOrigin('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(normalizeOrigin('app.github.io')).toBe('app.github.io');
    expect(normalizeOrigin('www.alice.github.io')).toBe('alice.github.io');
    expect(normalizeOrigin('localhost:8080')).toBe('localhost');
  });

  test('v2 fields are length-prefixed: a username cannot pose as a rotation', () => {
    // v1: "tommi\0" + "1" at rotation 0 is the bytes of "tommi" at rotation 1
    expect(pw('forum.z.cash', 'tommi\u00001', 0, 1)).toBe(pw('forum.z.cash', 'tommi', 1, 1));
    expect(pw('forum.z.cash', 'tommi\u00001', 0)).not.toBe(pw('forum.z.cash', 'tommi', 1));
    // nor can a site and a username trade bytes
    expect(pw('a.example', 'b')).not.toBe(pw('a.exampl', 'eb'));
  });

  test('v1 and v2 give different passwords for the same inputs', () => {
    expect(pw('forum.z.cash', 'tommi', 0, 1)).not.toBe(pw('forum.z.cash', 'tommi', 0, 2));
  });

  test('a saved login without a scheme is v1; new ones say 2', () => {
    expect(schemeOf({})).toBe(1);
    expect(schemeOf({ scheme: 1 })).toBe(1);
    expect(schemeOf({ scheme: 2 })).toBe(2);
  });
});
