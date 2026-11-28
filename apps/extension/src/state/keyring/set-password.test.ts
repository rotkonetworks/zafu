import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { decryptVault } from './crypto-ops';
import { NoPasswordError, PasswordMismatchError } from '.';
import type { EncryptedVault } from './types';
import { legacyAirgapProfile } from './legacy-airgap.test-util';

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
    // a profile from before #160: its first zigner sealed under the empty password
    const id = await legacyAirgapProfile(useStore, {
      viewingKey: 'em9yY2hhcmQtZnZr',
      accountIndex: 0,
      deviceId: 'dev',
    });
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

// #160: no profile is sealed under an empty password, and none opens with one
describe('every profile has a password', () => {
  const code = { viewingKey: 'em9yY2hhcmQtZnZr', accountIndex: 0, deviceId: 'dev' };
  let useStore: TestStore;
  const kr = () => useStore.getState().keyRing;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('a cold wallet on a profile with no password is refused, and nothing is stored', async () => {
    await expect(kr().addZignerUnencrypted(code, 'zigner')).rejects.toThrow(NoPasswordError);
    expect(localMock.has('passwordKeyPrint')).toBe(false);
    expect(localMock.has('vaults')).toBe(false);
    expect(sessionMock.has('passwordKey')).toBe(false);
  });

  test('an empty password is never set, opened with, or changed to', async () => {
    await expect(kr().setPassword('')).rejects.toThrow(NoPasswordError);
    await kr().setPassword('a real password');
    kr().lock();
    expect(await kr().unlock('')).toBe(false);
    expect(await kr().checkPassword('')).toBe(false);
    await expect(kr().changePassword('a real password', '')).rejects.toThrow(NoPasswordError);
  });

  test('a cold wallet locks and unlocks with its password in the same session', async () => {
    await kr().setPassword('a real password');
    await kr().addZignerUnencrypted(code, 'zigner');
    kr().lock();
    expect(kr().status).toBe('locked');
    expect(await kr().unlock('a real password')).toBe(true);
    expect(kr().status).toBe('unlocked');
  });

  test('a profile from before opens with nothing, asks for a password, then opens only with it', async () => {
    const id = await legacyAirgapProfile(useStore, code);
    // the old build left its empty-password key in the session
    expect(sessionMock.has('passwordKey')).toBe(true);

    await kr().init();
    expect(kr().status).toBe('locked');
    expect(kr().needsPassword).toBe(true);
    expect(sessionMock.has('passwordKey')).toBe(false);

    await kr().setPassword('the new password');
    expect(kr().needsPassword).toBe(false);
    kr().lock();
    expect(await kr().unlock('')).toBe(false);
    expect(await kr().unlock('the new password')).toBe(true);
    const vault = ((localMock.get('vaults') ?? []) as EncryptedVault[]).find(v => v.id === id)!;
    expect(vault.insensitive['airgapOnly']).toBeUndefined();

    // and the next start asks for it, no longer for a new one
    await kr().init();
    expect(kr().needsPassword).toBe(false);
  });
});
