import { beforeEach, describe, expect, test } from 'vitest';
import { Box, type BoxJson } from '@repo/encryption/box';
import { Key } from '@repo/encryption/key';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { isEncryptedWrapper, markHydrated } from './encrypted-storage';
import { clearPersonalData, readTxNotes, writeTxNotes } from './personal-data';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;

describe('clearPersonalData', () => {
  beforeEach(async () => {
    localMock.clear();
    await chrome.storage.local.set({
      txNotes: { tx: 'rent' },
      passwordLogins: [{ site: 'example.org' }],
      passkeyGrants: { 'example.org': 'wallet' },
      yourAddresses: [{ chain: 'bitcoin' }],
    });
  });

  test('clears only what it is asked to', async () => {
    await clearPersonalData({ notes: true, sent: false, logins: false, addresses: false });
    expect(localMock.has('txNotes')).toBe(false);
    expect(localMock.has('passwordLogins')).toBe(true);
    expect(localMock.has('passkeyGrants')).toBe(true);
    expect(localMock.has('yourAddresses')).toBe(true);
  });

  test('clears saved logins and your addresses when asked', async () => {
    await clearPersonalData({ notes: false, sent: false, logins: true, addresses: true });
    expect(localMock.has('txNotes')).toBe(true);
    expect(localMock.has('passwordLogins')).toBe(false);
    expect(localMock.has('passkeyGrants')).toBe(false);
    expect(localMock.has('yourAddresses')).toBe(false);
  });
});

describe('tx notes at rest', () => {
  const unlock = async () => {
    const { key } = await Key.create('pw');
    await sessionExtStorage.set('passwordKey', await key.toJson());
    return key;
  };

  beforeEach(async () => {
    localMock.clear();
    await chrome.storage.session.clear();
    // stamp the storage version first, so the old-shaped value is not taken for a v0 profile
    await localExtStorage.remove('txNotes' as never);
    markHydrated();
  });

  test('a plaintext map from an older version is sealed on first read', async () => {
    const key = await unlock();
    await chrome.storage.local.set({ txNotes: { tx1: 'rent from alice' } });
    expect(await readTxNotes()).toEqual({ tx1: 'rent from alice' });
    const stored = localMock.get('txNotes');
    expect(isEncryptedWrapper(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('alice');
    const plain = await key.unseal(Box.fromJson((stored as { encrypted: BoxJson }).encrypted));
    expect(JSON.parse(plain!)).toEqual({ tx1: 'rent from alice' });
    // and reads back the same once sealed
    expect(await readTxNotes()).toEqual({ tx1: 'rent from alice' });
  });

  test('a write merges into the sealed map', async () => {
    await unlock();
    await writeTxNotes({ tx1: 'rent' });
    expect(await writeTxNotes({ tx2: 'lunch' })).toBe(true);
    expect(await readTxNotes()).toEqual({ tx1: 'rent', tx2: 'lunch' });
    expect(JSON.stringify(localMock.get('txNotes'))).not.toContain('lunch');
  });

  test('locked, a read throws and nothing on disk changes', async () => {
    await chrome.storage.local.set({ txNotes: { tx1: 'rent' } });
    await expect(readTxNotes()).rejects.toThrow();
    await expect(writeTxNotes({ tx2: 'lunch' })).rejects.toThrow();
    expect(localMock.get('txNotes')).toEqual({ tx1: 'rent' });
  });
});
