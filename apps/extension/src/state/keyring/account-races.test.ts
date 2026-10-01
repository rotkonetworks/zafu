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
import { nukeAllWalletData } from './wallet-entries';
import { finishPendingWipe } from '../../clear-cache-startup';
import { keyUse } from '../keyring-lock';
import { Box } from '@repo/encryption/box';
import { issueWorkerKey, openKeySeal } from '../../shared/vault-seal';

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

describe('erase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  test('asks the offscreen host to stop the workers, and waits for it', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(send as never);
    await nukeAllWalletData(sessionExtStorage, localExtStorage);
    expect(send).toHaveBeenCalledWith({ type: 'NW_TERMINATE', network: 'zcash' });
    expect(send).toHaveBeenCalledWith({ type: 'NW_TERMINATE', network: 'penumbra' });
  });

  test('a database still held open is finished by a restart, never reported done', async () => {
    let dbs = [{ name: 'zafu-zcash' }, { name: 'viewdata/penumbra/w1' }];
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      databases: async () => dbs,
      deleteDatabase: () => {
        const req = {} as IDBOpenDBRequest;
        queueMicrotask(() => req.onblocked?.(new Event('blocked') as IDBVersionChangeEvent));
        return req;
      },
    };
    const reload = vi.fn();
    const rt = chrome.runtime as unknown as Record<string, unknown>;
    rt['reload'] = reload;
    await chrome.storage.local.set({ zafuTheme: 'washi', dbVersion: 4, vaults: [{ id: 'v' }] });
    const outcome = await Promise.race([
      nukeAllWalletData(sessionExtStorage, localExtStorage, '/welcome/import').then(() => 'done'),
      new Promise(r => setTimeout(() => r('restarting'), 100)),
    ]);
    expect(outcome).toBe('restarting');
    expect(reload).toHaveBeenCalled();
    const left = await chrome.storage.local.get(null);
    expect(left).toMatchObject({
      pendingWipe: { then: '/welcome/import' },
      zafuTheme: 'washi',
      dbVersion: 4,
    });
    expect(left['vaults']).toBeUndefined();

    // the next start deletes what was held and opens the import page
    const create = vi.fn(async () => ({}));
    const c = chrome as unknown as Record<string, unknown>;
    c['tabs'] = { create };
    rt['getURL'] = (p: string) => `chrome-extension://x/${p}`;
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      databases: async () => dbs,
      deleteDatabase: (name: string) => {
        const req = {} as IDBOpenDBRequest;
        dbs = dbs.filter(d => d.name !== name);
        queueMicrotask(() => req.onsuccess?.(new Event('success')));
        return req;
      },
    };
    await finishPendingWipe();
    expect(dbs).toEqual([]);
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://x/page.html#/welcome/import' });
    expect((await chrome.storage.local.get('pendingWipe'))['pendingWipe']).toBeUndefined();
    delete c['tabs'];
    delete rt['reload'];
    delete rt['getURL'];
  });
});

describe('password change, second review', () => {
  let a: TestStore;
  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    markHydrated();
    a = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });
  afterEach(() => vi.restoreAllMocks());

  test('D: another context writing its wallet list from before the change keeps the seed opening', async () => {
    await a.getState().keyRing.setPassword(OLD);
    await a.getState().wallets.addWallet({ label: 'p', seedPhrase: SEED.split(' ') });
    // a side panel's copy, hydrated before the change
    const stale = JSON.parse(JSON.stringify(a.getState().wallets.all));
    expect(await a.getState().keyRing.changePassword(OLD, NEW)).toBe(true);
    const { createEncryptedLocal } = await import('../encrypted-storage');
    await createEncryptedLocal(localExtStorage, sessionExtStorage).set('penumbraWallets', stale);
    // what a new realm hydrates after unlocking with the new password
    a.getState().keyRing.lock();
    expect(await sessionExtStorage.get('retiredPasswordKey')).toBeUndefined();
    expect(await a.getState().keyRing.unlock(NEW)).toBe(true);
    const list = (await readEncrypted<{ custody: { encryptedSeedPhrase?: never } }[]>(
      localExtStorage,
      sessionExtStorage,
      'penumbraWallets' as LK,
    ))!;
    const key = await Key.fromJson((await sessionExtStorage.get('passwordKey'))!);
    expect(await key.unseal(Box.fromJson(list[0]!.custody.encryptedSeedPhrase!))).toBe(SEED);
  });

  test('E: a change started from inside a key use gives up after the wait, nothing changed', async () => {
    await a.getState().keyRing.setPassword(OLD);
    await a.getState().keyRing.newMnemonicKey(SEED, 'hot');
    const print = localMock.get('passwordKeyPrint');
    await expect(keyUse(() => a.getState().keyRing.changePassword(OLD, NEW))).rejects.toThrow(
      'busy',
    );
    expect(localMock.get('passwordKeyPrint')).toEqual(print);
  }, 30000);

  test('a box that no longer opens is kept aside and read as absent', async () => {
    await a.getState().keyRing.setPassword(OLD);
    const other = (await Key.create('a long-gone password')).key;
    const orphan = { encrypted: (await other.seal(JSON.stringify([{ a: 1 }]))).toJson() };
    await chrome.storage.local.set({ diversifiedAddresses: orphan });
    expect(await getDiversifiedAddresses()).toEqual([]);
    expect(localMock.get('diversifiedAddresses.unopened')).toEqual(orphan);
    expect(localMock.has('diversifiedAddresses')).toBe(false);
    await setDiversifiedAddresses([{ a: 2 }] as never);
    expect(await getDiversifiedAddresses()).toEqual([{ a: 2 }]);
  });

  test('a vault unlock reads its box with the key it seals, after a change too', async () => {
    await a.getState().keyRing.setPassword(OLD);
    const id = await a.getState().keyRing.newMnemonicKey(SEED, 'hot');
    const unlock = await a.getState().keyRing.getVaultUnlock(id);
    expect(await a.getState().keyRing.changePassword(OLD, NEW)).toBe(true);
    const sealed = await unlock.sealTo(await issueWorkerKey());
    const key = await openKeySeal(sealed.seal);
    expect(await Key.unsealWith(key!, Box.fromJson(JSON.parse(sealed.box)))).toBe(SEED);
  });

  test('an empty-password profile with a hot vault is not handed a new password', async () => {
    await a
      .getState()
      .keyRing.addZignerUnencrypted(
        { viewingKey: 'em9yY2hhcmQtZnZr', accountIndex: 0, deviceId: 'dev' },
        'zigner',
      );
    await a.getState().keyRing.newMnemonicKey(SEED, 'hot'); // sealed under the '' key
    const print = localMock.get('passwordKeyPrint');
    await expect(a.getState().keyRing.setPassword('a guess')).rejects.toThrow();
    expect(localMock.get('passwordKeyPrint')).toEqual(print);
  });
});
