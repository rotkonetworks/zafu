import { describe, expect, test } from 'vitest';
import { grantCapability, denyCapability, getOriginPermissions, getAllPermissions } from './origin';
import { GRANT_TTL_MS, TIME_LIMITED_CAPABILITIES, hasCapability } from './capabilities';
import { localExtStorage } from './local';

// tests-setup.ts installs a mock chrome.storage + navigator.locks; every test
// file starts with a fresh storage area.

describe('grantCapability - expiry stamping', () => {
  test('a time-limited capability gets expires[cap] ~30 days out', async () => {
    const origin = 'https://silent-decrypt.example';
    const before = Date.now();
    await grantCapability(origin, 'encrypt');
    const after = Date.now();

    const perms = await getOriginPermissions(origin);
    expect(perms?.granted).toContain('encrypt');
    const expiresAt = perms?.expires?.encrypt;
    expect(expiresAt).toBeDefined();
    expect(expiresAt!).toBeGreaterThanOrEqual(before + GRANT_TTL_MS);
    expect(expiresAt!).toBeLessThanOrEqual(after + GRANT_TTL_MS);

    // and the shared helper honors it right away
    expect(hasCapability(perms, 'encrypt')).toBe(true);
  });

  test('a non time-limited capability gets no expiry and never lapses', async () => {
    const origin = 'https://connect-only.example';
    await grantCapability(origin, 'connect');
    const perms = await getOriginPermissions(origin);
    expect(perms?.expires?.connect).toBeUndefined();
    expect(hasCapability(perms, 'connect', Date.now() + 1000 * 365 * 24 * 60 * 60 * 1000)).toBe(
      true,
    );
  });

  test('re-granting an expired time-limited capability refreshes its expiry', async () => {
    const origin = 'https://renew.example';
    await grantCapability(origin, 'passkey');
    const firstPerms = await getOriginPermissions(origin);
    const firstExpiry = firstPerms!.expires!.passkey!;

    // simulate the grant having expired
    expect(hasCapability(firstPerms, 'passkey', firstExpiry + 1)).toBe(false);

    // re-approval (grantCapability called again) issues a fresh expiry that
    // is never earlier than the one it replaces, and is valid again right now
    await grantCapability(origin, 'passkey');
    const secondPerms = await getOriginPermissions(origin);
    const secondExpiry = secondPerms!.expires!.passkey!;
    expect(secondExpiry).toBeGreaterThanOrEqual(firstExpiry);
    expect(hasCapability(secondPerms, 'passkey')).toBe(true);
  });

  test('every capability in TIME_LIMITED_CAPABILITIES is stamped on grant', async () => {
    for (const cap of TIME_LIMITED_CAPABILITIES) {
      const origin = `https://${cap}.example`;
      await grantCapability(origin, cap);
      const perms = await getOriginPermissions(origin);
      expect(perms?.expires?.[cap]).toBeDefined();
    }
  });
});

describe('a pre-existing grant with no recorded expiry (upgrade safety)', () => {
  test('is treated as expired for a time-limited capability', async () => {
    const origin = 'https://legacy-grant.example';
    // simulate storage written before the expiry mechanism existed: granted,
    // but no `expires` map at all.
    await grantCapability(origin, 'encrypt');
    const perms = await getOriginPermissions(origin);
    delete perms!.expires;

    expect(hasCapability(perms, 'encrypt')).toBe(false);
  });
});

describe('reads prune expired time-limited capabilities out of `granted`', () => {
  test('getOriginPermissions does not report an expired capability as granted', async () => {
    const origin = 'https://stale-in-storage.example';
    await localExtStorage.set('knownSites', [
      {
        origin,
        granted: ['connect', 'encrypt'],
        denied: [],
        grantedAt: 0,
        expires: { encrypt: Date.now() - 1000 },
      },
    ] as never);

    const perms = await getOriginPermissions(origin);
    expect(perms?.granted).toContain('connect');
    expect(perms?.granted).not.toContain('encrypt');
    // the capability's own record is otherwise untouched (not a denial)
    expect(perms?.denied ?? []).not.toContain('encrypt');
  });

  test('pruning is read-only: it does not persist a write back to storage', async () => {
    const origin = 'https://read-only-prune.example';
    const stored = {
      origin,
      granted: ['encrypt'],
      denied: [],
      grantedAt: 0,
      expires: { encrypt: Date.now() - 1000 },
    };
    await localExtStorage.set('knownSites', [stored] as never);

    await getOriginPermissions(origin);
    await getAllPermissions();

    const raw = await localExtStorage.get('knownSites');
    expect((raw as unknown as (typeof stored)[])[0]?.granted).toContain('encrypt');
  });
});

describe('denyCapability clears a stale expiry', () => {
  test('denying a previously-granted time-limited capability drops its expires entry', async () => {
    const origin = 'https://revoke.example';
    await grantCapability(origin, 'encrypt');
    await denyCapability(origin, 'encrypt');
    const perms = await getOriginPermissions(origin);
    expect(perms?.granted).not.toContain('encrypt');
    expect(perms?.denied).toContain('encrypt');
    expect(perms?.expires?.encrypt).toBeUndefined();
  });
});
