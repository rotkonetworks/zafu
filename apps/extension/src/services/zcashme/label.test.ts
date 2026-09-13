/** @vitest-environment node */

import { describe, expect, test } from 'vitest';
import { zcashMeLabel, zcashMeUsername } from './label';
import type { ZcashMeProfile } from './api';

const p = (over: Partial<ZcashMeProfile>): ZcashMeProfile => ({
  username: 'x',
  displayName: null,
  address: 'u1',
  addressVerified: false,
  bio: null,
  location: null,
  profileImageUrl: null,
  links: [],
  ...over,
});

describe('zcash.me labels', () => {
  test('strips the row-id suffix only from unverified names', () => {
    expect(zcashMeUsername(p({ username: 'Kroy-249' }))).toBe('Kroy');
    expect(zcashMeUsername(p({ username: 'alice-2', addressVerified: true }))).toBe('alice-2');
  });

  test('prefers the display name', () => {
    expect(zcashMeLabel(p({ username: 'yoshi', displayName: 'Yoshi' }))).toBe('Yoshi');
    expect(zcashMeLabel(p({ username: 'bob-7' }))).toBe('bob');
    expect(zcashMeLabel(undefined)).toBeUndefined();
  });
});
