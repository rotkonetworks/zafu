import { describe, expect, test } from 'vitest';
import {
  CAPABILITY_META,
  GRANT_TTL_MS,
  TIME_LIMITED_CAPABILITIES,
  hasCapability,
  isDenied,
  type OriginPermissions,
} from './capabilities';

const basePerms = (overrides: Partial<OriginPermissions> = {}): OriginPermissions => ({
  origin: 'https://example.com',
  granted: [],
  denied: [],
  grantedAt: 0,
  ...overrides,
});

describe('hasCapability - non time-limited capabilities', () => {
  test('granted, no expiry needed -> true', () => {
    const perms = basePerms({ granted: ['connect'] });
    expect(hasCapability(perms, 'connect')).toBe(true);
  });

  test('not granted -> false', () => {
    const perms = basePerms({ granted: [] });
    expect(hasCapability(perms, 'connect')).toBe(false);
  });

  test('undefined perms -> false', () => {
    expect(hasCapability(undefined, 'connect')).toBe(false);
  });
});

describe('hasCapability - time-limited capabilities (encrypt, passkey)', () => {
  test.each([...TIME_LIMITED_CAPABILITIES])('%s: granted with future expiry -> true', cap => {
    const now = 1_000_000;
    const perms = basePerms({ granted: [cap], expires: { [cap]: now + 1 } });
    expect(hasCapability(perms, cap, now)).toBe(true);
  });

  test.each([...TIME_LIMITED_CAPABILITIES])('%s: granted with past expiry -> false', cap => {
    const now = 1_000_000;
    const perms = basePerms({ granted: [cap], expires: { [cap]: now - 1 } });
    expect(hasCapability(perms, cap, now)).toBe(false);
  });

  test.each([...TIME_LIMITED_CAPABILITIES])(
    '%s: granted with NO recorded expiry -> false (safe default for pre-TTL grants)',
    cap => {
      const perms = basePerms({ granted: [cap] });
      expect(hasCapability(perms, cap, Date.now())).toBe(false);
    },
  );

  test('expiry on one capability does not affect another capability on the same origin', () => {
    const now = 1_000_000;
    const perms = basePerms({
      granted: ['encrypt', 'passkey'],
      expires: { encrypt: now + 1, passkey: now - 1 },
    });
    expect(hasCapability(perms, 'encrypt', now)).toBe(true);
    expect(hasCapability(perms, 'passkey', now)).toBe(false);
  });

  test('GRANT_TTL_MS is 30 days', () => {
    expect(GRANT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('boundary: expiresAt === now is treated as expired', () => {
    const now = 1_000_000;
    const perms = basePerms({ granted: ['encrypt'], expires: { encrypt: now } });
    expect(hasCapability(perms, 'encrypt', now)).toBe(false);
  });

  test('a non-finite expiry (Infinity) is refused, not trusted', () => {
    const perms = basePerms({ granted: ['encrypt'], expires: { encrypt: Infinity } });
    expect(hasCapability(perms, 'encrypt')).toBe(false);
  });

  test('a NaN expiry is refused', () => {
    const perms = basePerms({ granted: ['encrypt'], expires: { encrypt: NaN } });
    expect(hasCapability(perms, 'encrypt')).toBe(false);
  });

  test('an expiry further out than GRANT_TTL_MS from now is refused (clock-skew guard)', () => {
    const now = 1_000_000;
    const perms = basePerms({
      granted: ['encrypt'],
      expires: { encrypt: now + GRANT_TTL_MS + 1 },
    });
    expect(hasCapability(perms, 'encrypt', now)).toBe(false);
  });

  test('an expiry exactly GRANT_TTL_MS out is accepted', () => {
    const now = 1_000_000;
    const perms = basePerms({ granted: ['encrypt'], expires: { encrypt: now + GRANT_TTL_MS } });
    expect(hasCapability(perms, 'encrypt', now)).toBe(true);
  });
});

describe('auto_sign is intentionally not time-limited', () => {
  test('auto_sign is not in TIME_LIMITED_CAPABILITIES', () => {
    expect(TIME_LIMITED_CAPABILITIES.has('auto_sign')).toBe(false);
  });

  test('a granted auto_sign capability is usable with no expiry stamped at all', () => {
    const perms = basePerms({ granted: ['auto_sign'] });
    expect(hasCapability(perms, 'auto_sign')).toBe(true);
  });
});

describe('isDenied', () => {
  test('capability in denied list -> true', () => {
    const perms = basePerms({ denied: ['encrypt'] });
    expect(isDenied(perms, 'encrypt')).toBe(true);
  });

  test('capability not denied -> false', () => {
    expect(isDenied(basePerms(), 'encrypt')).toBe(false);
  });

  test('undefined perms -> false', () => {
    expect(isDenied(undefined, 'encrypt')).toBe(false);
  });
});

test('every time-limited capability is a real Capability with metadata', () => {
  for (const cap of TIME_LIMITED_CAPABILITIES) {
    expect(CAPABILITY_META[cap]).toBeDefined();
  }
});
