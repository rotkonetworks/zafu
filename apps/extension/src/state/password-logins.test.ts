import { beforeEach, describe, expect, test, vi } from 'vitest';

// the sealed store, as the encrypted helpers see it: whatever was last written
const sealed = vi.hoisted(() => ({ value: undefined as unknown, locked: false }));
vi.mock('./encrypted-storage', () => ({
  readEncryptedWithMigration: () =>
    sealed.locked ? Promise.reject(new Error('locked')) : Promise.resolve(sealed.value ?? null),
  writeEncryptedDirect: (_l: unknown, _s: unknown, key: string, data: unknown) => {
    expect(key).toBe('passwordLogins');
    sealed.value = JSON.parse(JSON.stringify(data));
    return Promise.resolve(true);
  },
}));
vi.mock('@repo/storage-chrome/local', () => ({ localExtStorage: {} }));
vi.mock('@repo/storage-chrome/session', () => ({ sessionExtStorage: {} }));

import {
  forgetPasswordLogin,
  readPasswordLogins,
  restorePasswordLogins,
  savePasswordLogin,
  type PasswordLogin,
} from './password-logins';

const login = (over: Partial<PasswordLogin> = {}): PasswordLogin => ({
  owner: 'zid-a',
  site: 'github.com',
  username: 'alice',
  length: 32,
  version: 0,
  savedAt: 1,
  ...over,
});

beforeEach(() => {
  sealed.value = undefined;
  sealed.locked = false;
});

describe('saved logins', () => {
  test('keep one per wallet, site and username, the newest first', async () => {
    await savePasswordLogin(login());
    await savePasswordLogin(login({ site: 'example.org' }));
    const next = await savePasswordLogin(login({ version: 2, length: 24 }));
    expect(next.map(l => [l.site, l.version])).toEqual([
      ['github.com', 2],
      ['example.org', 0],
    ]);
    // another wallet's phrase derives other passwords: its own entry
    await savePasswordLogin(login({ owner: 'zid-b' }));
    expect(await readPasswordLogins()).toHaveLength(3);
  });

  test('never hold a password', async () => {
    await savePasswordLogin(login());
    expect(Object.keys((sealed.value as object[])[0]!).sort()).toEqual([
      'length',
      'owner',
      'savedAt',
      'site',
      'username',
      'version',
    ]);
  });

  test('forget drops only that login', async () => {
    await savePasswordLogin(login());
    await savePasswordLogin(login({ username: 'bob' }));
    expect((await forgetPasswordLogin(login())).map(l => l.username)).toEqual(['bob']);
  });

  test('a locked wallet throws instead of writing back an empty list', async () => {
    await savePasswordLogin(login());
    sealed.locked = true;
    await expect(savePasswordLogin(login({ site: 'x.org' }))).rejects.toThrow();
    sealed.locked = false;
    expect(await readPasswordLogins()).toHaveLength(1);
  });

  test('restore merges or replaces, and skips what is not a login', async () => {
    await savePasswordLogin(login());
    const backup = [login({ version: 3 }), login({ site: 'new.org' }), { site: 1 }, null];
    expect(await restorePasswordLogins(backup, 'merge')).toBe(2);
    // merge keeps what is here
    expect((await readPasswordLogins()).map(l => [l.site, l.version])).toEqual([
      ['github.com', 0],
      ['new.org', 0],
    ]);
    await restorePasswordLogins(backup, 'replace');
    expect((await readPasswordLogins()).map(l => [l.site, l.version])).toEqual([
      ['github.com', 3],
      ['new.org', 0],
    ]);
  });
});

describe('sealed at rest', () => {
  test('passwordLogins is an encrypted key', async () => {
    const real = await vi.importActual<typeof import('./encrypted-storage')>('./encrypted-storage');
    expect(real.isEncryptedKey('passwordLogins')).toBe(true);
  });
});
