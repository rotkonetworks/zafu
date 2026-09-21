import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

// Regression: keyRing.setPassword must never orphan an already-sealed vault.
// Onboarding create/import/zigner flows call setPassword unconditionally; when a
// wallet already existed, the old code minted a fresh random salt and overwrote
// the keyprint WITHOUT re-encrypting the existing vaults - so the seed could no
// longer be decrypted ("failed to decrypt vault") even with the right password,
// while FVK sync kept working. This locks in the re-seal behavior.
describe('keyRing.setPassword re-seals existing vaults', () => {
  const password = 's0meUs3rP@ssword';
  const newPassword = 'a-completely-different-passw0rd';
  const seedPhrase = [
    'advance twist canal impact field normal depend pink sick horn world broccoli',
  ];

  let useStore: TestStore;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('a sealed mnemonic vault still decrypts after setPassword runs again', async () => {
    // fresh profile -> seal a hot wallet the way onboarding does (newMnemonicKey)
    await useStore.getState().keyRing.setPassword(password);
    const vaultId = await useStore
      .getState()
      .keyRing.newMnemonicKey(seedPhrase.join(' '), 'Wallet 1');

    const before = await useStore.getState().keyRing.getMnemonic(vaultId);
    expect(before).toBe(seedPhrase.join(' '));

    // the bug trigger: a second setPassword on an existing wallet (e.g. the
    // "set password" step of a zigner import / re-run onboarding).
    await useStore.getState().keyRing.setPassword(newPassword);

    // previously threw "failed to decrypt vault"
    const after = await useStore.getState().keyRing.getMnemonic(vaultId);
    expect(after).toBe(before);

    // and the password is now the new one, consistently
    useStore.getState().keyRing.lock();
    expect(await useStore.getState().keyRing.unlock(newPassword)).toBe(true);
    expect(await useStore.getState().keyRing.getMnemonic(vaultId)).toBe(before);

    useStore.getState().keyRing.lock();
    expect(await useStore.getState().keyRing.unlock(password)).toBe(false);
  });

  test('a penumbra hot wallet seed still reveals after setPassword runs again', async () => {
    await useStore.getState().keyRing.setPassword(password);
    // wallets.addWallet stores the penumbra seed in penumbraWallets custody,
    // sealed under the master key (a different store from the vault list).
    await useStore.getState().wallets.addWallet({ label: 'Account #1', seedPhrase });

    const before = await useStore.getState().wallets.getSeedPhrase();
    expect(before.join(' ')).toBe(seedPhrase.join(' '));

    // the bug trigger again - previously orphaned the penumbra seed too
    await useStore.getState().keyRing.setPassword(newPassword);

    const after = await useStore.getState().wallets.getSeedPhrase();
    expect(after).toEqual(before);
  });

  test('setPassword refuses to re-seal hot vaults while locked (no orphaning)', async () => {
    await useStore.getState().keyRing.setPassword(password);
    const vaultId = await useStore
      .getState()
      .keyRing.newMnemonicKey(seedPhrase.join(' '), 'Wallet 1');
    const printBefore = await localExtStorage.get('passwordKeyPrint');

    // lock, then attempt a password reset with no session key available
    useStore.getState().keyRing.lock();
    await expect(useStore.getState().keyRing.setPassword(newPassword)).rejects.toThrow();

    // keyprint untouched -> the original password still opens the vault
    expect(await localExtStorage.get('passwordKeyPrint')).toEqual(printBefore);
    expect(await useStore.getState().keyRing.unlock(password)).toBe(true);
    expect(await useStore.getState().keyRing.getMnemonic(vaultId)).toBeTruthy();
  });
});
