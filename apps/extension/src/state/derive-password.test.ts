import { describe, expect, test } from 'vitest';
import { derivePassword, normalizeOrigin, DEFAULT_IDENTITY } from './identity';

// harness test phrase (zero funds, never holds anything real)
const SEED = Array(23).fill('abandon').concat(['art']).join(' ');
const B85_CHARS = /^[0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]*$/;

describe('derivePassword', () => {
  // fixed vector - pins the output after fixing the sign bug below. the
  // first 5-char group was never affected by that bug (see next test), so
  // this also proves the fix did not change any password that was ever a
  // real, usable password.
  test('fixed vector: forum.z.cash / tommi / 32 / rotation 0', () => {
    expect(derivePassword(SEED, DEFAULT_IDENTITY, 'forum.z.cash', 'tommi', 32, 0)).toBe(
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
