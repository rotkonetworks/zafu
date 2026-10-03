import { beforeEach, describe, expect, test } from 'vitest';
import { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import { storage } from '@repo/mock-chrome';
const { local: mockLocal, session: mockSession } = storage;
import { Key } from '@repo/encryption/key';
import { isEncryptedWrapper, readEncrypted, readEncryptedWithMigration } from './encrypted-storage';

// readEncrypted/readEncryptedWithMigration are generic over LocalStorageState,
// but these tests only exercise keys that are ENCRYPTED_KEYS at runtime; the
// precise key name doesn't matter to the code under test.
const STORAGE_KEY = 'zcashWallets' as keyof LocalStorageState;

describe('isEncryptedWrapper', () => {
  test('rejects a sealed-looking wrapper whose inner box is missing nonce/cipherText', () => {
    // this is exactly the shape a corrupted or partially-written sealed value
    // would have at rest: an object under `encrypted`, but not a real BoxJson
    expect(isEncryptedWrapper({ encrypted: { c: 'x', n: 'y' } })).toBe(false);
  });

  test('rejects a bare object with no encrypted property', () => {
    expect(isEncryptedWrapper({})).toBe(false);
    expect(isEncryptedWrapper(null)).toBe(false);
    expect(isEncryptedWrapper(undefined)).toBe(false);
    expect(isEncryptedWrapper([])).toBe(false);
  });

  test('accepts a real BoxJson wrapper', () => {
    expect(isEncryptedWrapper({ encrypted: { nonce: 'bm9uY2U=', cipherText: 'Y2lwaGVy' } })).toBe(
      true,
    );
  });
});

describe('readEncrypted with malformed sealed data', () => {
  let local: ExtensionStorage<LocalStorageState>;
  let session: ExtensionStorage<SessionStorageState>;
  let key: Key;

  beforeEach(async () => {
    await mockLocal.clear();
    await mockSession.clear();
    local = new ExtensionStorage<LocalStorageState>(
      mockLocal,
      { penumbraWallets: [], knownSites: [], numeraires: [] },
      undefined,
    );
    session = new ExtensionStorage<SessionStorageState>(mockSession, {}, undefined);

    key = (await Key.create('test-password')).key;
    await session.set('passwordKey', await key.toJson());
  });

  test('never throws and returns null when the inner box is missing nonce/cipherText', async () => {
    // simulates a value another realm left behind mid-write, or any other
    // process that produced an `{ encrypted: {...} }` shape without a real box
    await mockLocal.set({ [STORAGE_KEY]: { encrypted: { c: 'x', n: 'y' } } });

    await expect(readEncrypted(local, session, STORAGE_KEY)).resolves.toBeNull();
  });

  test('a genuinely sealed value still decrypts normally', async () => {
    // build the sealed value directly (bypassing writeEncrypted, which waits
    // on a module-level hydration gate this test never completes)
    const box = await key.seal(JSON.stringify([{ id: 'w1' }]));
    await mockLocal.set({ [STORAGE_KEY]: { encrypted: box.toJson() } });

    await expect(readEncrypted(local, session, STORAGE_KEY)).resolves.toEqual([{ id: 'w1' }]);
  });

  test('readEncryptedWithMigration keeps a malformed sealed value aside instead of resealing it as plaintext', async () => {
    await mockLocal.set({ [STORAGE_KEY]: { encrypted: { c: 'x', n: 'y' } } });

    await expect(readEncryptedWithMigration(local, session, STORAGE_KEY)).resolves.toBeNull();

    // the original malformed value must not survive under its real key (it
    // would otherwise get decrypted - and crash - on every later read), and
    // must not have been re-sealed as if it were legitimate legacy plaintext
    const stored = (await mockLocal.get(STORAGE_KEY as string))[STORAGE_KEY as string];
    expect(stored).toBeUndefined();
    const keptAside = (await mockLocal.get(`${STORAGE_KEY}.unopened`))[`${STORAGE_KEY}.unopened`];
    expect(keptAside).toEqual({ encrypted: { c: 'x', n: 'y' } });
  });
});
