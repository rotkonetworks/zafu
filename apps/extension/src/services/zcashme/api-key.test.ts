import { beforeEach, describe, expect, test } from 'vitest';
import { Key } from '@repo/encryption/key';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { isEncryptedWrapper, markHydrated } from '../../state/encrypted-storage';
import { readZcashMeApiKey, sealZcashMeApiKey, writeZcashMeApiKey } from './api-key';
import { writeZcashMeConfig } from './config';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const legacy = { mode: 'directory', mirrorUrl: '', apiKey: 'own-key', decoys: 0 } as const;

const unlock = async () =>
  sessionExtStorage.set('passwordKey', await (await Key.create('pw')).key.toJson());

describe('zcash.me api key at rest', () => {
  beforeEach(async () => {
    localMock.clear();
    await chrome.storage.session.clear();
    await localExtStorage.remove('zcashMeConfig');
    markHydrated();
  });

  test('a key an older version kept in the plain config is sealed on unlock', async () => {
    await chrome.storage.local.set({ zcashMeConfig: legacy });
    await unlock();
    await sealZcashMeApiKey();
    expect(localMock.get('zcashMeConfig')).toEqual({ ...legacy, apiKey: '' });
    expect(isEncryptedWrapper(localMock.get('zcashMeApiKey'))).toBe(true);
    expect(JSON.stringify([...localMock.values()])).not.toContain('own-key');
    expect(await readZcashMeApiKey()).toBe('own-key');
  });

  test('locked, the plain key stays where it is and reads as none', async () => {
    await chrome.storage.local.set({ zcashMeConfig: legacy });
    expect(await readZcashMeApiKey()).toBe('');
    expect(localMock.get('zcashMeConfig')).toEqual(legacy);
    expect(localMock.has('zcashMeApiKey')).toBe(false);
  });

  test('a config change before the move keeps the old key', async () => {
    await chrome.storage.local.set({ zcashMeConfig: legacy });
    await writeZcashMeConfig({ mode: 'off', mirrorUrl: '', promptDismissed: true, decoys: 0 });
    expect(localMock.get('zcashMeConfig')).toMatchObject({ mode: 'off', apiKey: 'own-key' });
  });

  test('an emptied key is removed', async () => {
    await unlock();
    await writeZcashMeApiKey('own-key');
    expect(await readZcashMeApiKey()).toBe('own-key');
    await writeZcashMeApiKey('');
    expect(localMock.has('zcashMeApiKey')).toBe(false);
  });
});
