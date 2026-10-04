import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { decryptVault } from './crypto-ops';
import { PasswordMismatchError } from '.';
import type { EncryptedVault } from './types';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

// keyRing.setPassword on a profile that already has a password confirms it and
// never replaces it: the onboarding "set a password" step (a zigner or phrase
// added later) used to re-key to whatever was typed, and its rollback then
// restored vaults sealed under the old key beneath the new keyprint.
describe('keyRing.setPassword on an existing profile', () => {
  const password = 's0meUs3rP@ssword';
  const seedPhrase = 'advance twist canal impact field normal depend pink sick horn world broccoli';

  let useStore: TestStore;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('the same password unlocks and changes nothing', async () => {
    await useStore.getState().keyRing.setPassword(password);
    const id = await useStore.getState().keyRing.newMnemonicKey(seedPhrase, 'Wallet 1');
    const print = await localExtStorage.get('passwordKeyPrint');
    useStore.getState().keyRing.lock();

    await useStore.getState().keyRing.setPassword(password);
    expect(await localExtStorage.get('passwordKeyPrint')).toEqual(print);
    expect(await useStore.getState().keyRing.getMnemonic(id)).toBe(seedPhrase);
  });

  test('a different password is refused, and the old one still opens everything', async () => {
    await useStore.getState().keyRing.setPassword(password);
    const id = await useStore.getState().keyRing.newMnemonicKey(seedPhrase, 'Wallet 1');
    await useStore.getState().wallets.addWallet({ label: 'p', seedPhrase: seedPhrase.split(' ') });
    const before = Object.fromEntries(localMock);

    await expect(useStore.getState().keyRing.setPassword('something else')).rejects.toThrow(
      PasswordMismatchError,
    );
    expect(Object.fromEntries(localMock)).toEqual(before);

    useStore.getState().keyRing.lock();
    expect(await useStore.getState().keyRing.unlock('something else')).toBe(false);
    expect(await useStore.getState().keyRing.unlock(password)).toBe(true);
    expect(await useStore.getState().keyRing.getMnemonic(id)).toBe(seedPhrase);
    expect((await useStore.getState().wallets.getSeedPhrase()).join(' ')).toBe(seedPhrase);
  });
});

describe('keyRing.setPassword on an airgap-only profile', () => {
  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
  });

  test('moves the empty-password vault to the real password and ends auto-unlock', async () => {
    const useStore: TestStore = create<AllSlices>()(
      initializeStore(sessionExtStorage, localExtStorage),
    );
    const kr = () => useStore.getState().keyRing;
    // a fresh profile's first zigner import mints the empty-password key
    const id = await kr().addZignerUnencrypted(
      { viewingKey: 'em9yY2hhcmQtZnZr', accountIndex: 0, deviceId: 'dev' },
      'zigner',
    );
    const vault = () =>
      ((localMock.get('vaults') ?? []) as EncryptedVault[]).find(v => v.id === id)!;
    expect(vault().insensitive['airgapOnly']).toBe(true);

    await kr().setPassword('a real password');
    expect(vault().insensitive['airgapOnly']).toBeUndefined();
    expect(JSON.parse(await decryptVault({ session: sessionExtStorage }, vault()))).toMatchObject({
      deviceId: 'dev',
    });

    kr().lock();
    expect(await kr().unlock('')).toBe(false);
    expect(await kr().unlock('a real password')).toBe(true);
    expect(JSON.parse(await decryptVault({ session: sessionExtStorage }, vault()))).toMatchObject({
      deviceId: 'dev',
    });
  });
});
