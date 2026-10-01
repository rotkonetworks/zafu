/**
 * Races between a password change and everything else that touches sealed
 * data, from the account-flows review (cases A, B, C), turned around to pin
 * the fixed behaviour.
 */
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { markHydrated, readEncrypted, writeEncryptedDirect } from '../encrypted-storage';
import { getDiversifiedAddresses, setDiversifiedAddresses } from '../diversified-addresses';
import { Key } from '@repo/encryption/key';
import type { EncryptedVault } from './types';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;
type LK = Parameters<typeof readEncrypted>[2];
const OLD = 'old password long';
const NEW = 'new password long';
const SEED = 'advance twist canal impact field normal depend pink sick horn world broccoli';

/** start `during` once, inside the commit write, and hold the commit 50ms */
const duringCommit = (during: () => Promise<unknown>) => {
  const set = chrome.storage.local.set.bind(chrome.storage.local);
  let started: Promise<unknown> | undefined;
  vi.spyOn(chrome.storage.local, 'set').mockImplementation((async (
    items: Record<string, unknown>,
  ) => {
    if ('passwordKeyPrint' in items && !started) {
      started = during();
      // give it the whole window to run in, if anything lets it
      await new Promise(r => setTimeout(r, 50));
    }
    return set(items);
  }) as typeof chrome.storage.local.set);
  return () => started;
};

describe('password change races', () => {
  let store: TestStore;
  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    markHydrated();
    store = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });
  afterEach(() => vi.restoreAllMocks());

  test('A: a write sealed under the old key that lands after the commit is moved', async () => {
    await store.getState().keyRing.setPassword(OLD);
    await store.getState().keyRing.newMnemonicKey(SEED, 'hot');
    await writeEncryptedDirect(localExtStorage, sessionExtStorage, 'contacts' as LK, [{ id: 'a' }]);
    const k = await Key.fromJson((await sessionExtStorage.get('passwordKey'))!);
    const late = {
      contacts: { encrypted: (await k.seal(JSON.stringify([{ id: 'a' }, { id: 'b' }]))).toJson() },
    };
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    vi.spyOn(chrome.storage.local, 'set').mockImplementation((async (
      items: Record<string, unknown>,
    ) => {
      const r = await set(items);
      if ('passwordKeyPrint' in items) {
        await set(late); // a writer outside the lock, holding the old key
      }
      return r;
    }) as typeof chrome.storage.local.set);
    expect(await store.getState().keyRing.changePassword(OLD, NEW)).toBe(true);
    vi.restoreAllMocks();
    store.getState().keyRing.lock();
    expect(await store.getState().keyRing.unlock(NEW)).toBe(true);
    expect(await readEncrypted(localExtStorage, sessionExtStorage, 'contacts' as LK)).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  test('A2: a writer that starts mid-change waits and lands under the new key', async () => {
    await store.getState().keyRing.setPassword(OLD);
    await writeEncryptedDirect(localExtStorage, sessionExtStorage, 'contacts' as LK, [{ id: 'a' }]);
    const started = duringCommit(() =>
      writeEncryptedDirect(localExtStorage, sessionExtStorage, 'contacts' as LK, [
        { id: 'a' },
        { id: 'c' },
      ]),
    );
    expect(await store.getState().keyRing.changePassword(OLD, NEW)).toBe(true);
    expect(await started()).toBe(true);
    store.getState().keyRing.lock();
    expect(await store.getState().keyRing.unlock(NEW)).toBe(true);
    expect(await readEncrypted(localExtStorage, sessionExtStorage, 'contacts' as LK)).toEqual([
      { id: 'a' },
      { id: 'c' },
    ]);
  });

  test('B: a read during the change waits for it, so appending never wipes the list', async () => {
    await store.getState().keyRing.setPassword(OLD);
    await store.getState().keyRing.newMnemonicKey(SEED, 'hot');
    await setDiversifiedAddresses([{ a: 1 }, { a: 2 }] as never);
    const started = duringCommit(() => getDiversifiedAddresses());
    expect(await store.getState().keyRing.changePassword(OLD, NEW)).toBe(true);
    const read = (await started()) as unknown[];
    expect(read).toHaveLength(2);
    await setDiversifiedAddresses([...read, { a: 3 }] as never);
    expect(await getDiversifiedAddresses()).toHaveLength(3);
  });

  test('B2: a locked read-modify-write reader throws instead of answering empty', async () => {
    await store.getState().keyRing.setPassword(OLD);
    await setDiversifiedAddresses([{ a: 1 }] as never);
    store.getState().keyRing.lock();
    await expect(getDiversifiedAddresses()).rejects.toThrow('wallet is locked');
  });

  test('a vault rename that starts mid-change is kept', async () => {
    await store.getState().keyRing.setPassword(OLD);
    const id = await store.getState().keyRing.newMnemonicKey(SEED, 'hot');
    const started = duringCommit(() => store.getState().keyRing.renameKeyRing(id, 'renamed'));
    expect(await store.getState().keyRing.changePassword(OLD, NEW)).toBe(true);
    await started();
    const vaults = (await localExtStorage.get('vaults')) as EncryptedVault[];
    expect(vaults.find(v => v.id === id)?.name).toBe('renamed');
    expect(await store.getState().keyRing.getMnemonic(id)).toBe(SEED);
  });

  test('C: a set-password step on an existing profile neither re-keys nor orphans the seed', async () => {
    await store.getState().keyRing.setPassword(OLD);
    const id = await store.getState().keyRing.newMnemonicKey(SEED, 'hot');
    const vaultsSnapshot = (await localExtStorage.get('vaults')) ?? [];
    await expect(store.getState().keyRing.setPassword(NEW)).rejects.toThrow();
    await localExtStorage.set('vaults', vaultsSnapshot); // the onboarding rollback
    store.getState().keyRing.lock();
    expect(await store.getState().keyRing.unlock(NEW)).toBe(false);
    expect(await store.getState().keyRing.unlock(OLD)).toBe(true);
    expect(await store.getState().keyRing.getMnemonic(id)).toBe(SEED);
  });

  test('a profile with sealed data and no vaults is never re-keyed blind', async () => {
    await store.getState().keyRing.setPassword(OLD);
    await writeEncryptedDirect(localExtStorage, sessionExtStorage, 'contacts' as LK, [{ id: 'a' }]);
    const print = await localExtStorage.get('passwordKeyPrint');
    store.getState().keyRing.lock();
    await expect(store.getState().keyRing.setPassword(NEW)).rejects.toThrow();
    expect(await localExtStorage.get('passwordKeyPrint')).toEqual(print);
    expect(await store.getState().keyRing.unlock(OLD)).toBe(true);
    expect(await readEncrypted(localExtStorage, sessionExtStorage, 'contacts' as LK)).toEqual([
      { id: 'a' },
    ]);
  });
});
