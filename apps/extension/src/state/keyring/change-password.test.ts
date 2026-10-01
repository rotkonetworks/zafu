import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { markHydrated, readEncrypted, writeEncryptedDirect } from '../encrypted-storage';
import { decryptMultisigSecrets, decryptVault } from './crypto-ops';
import { loadVotingRoundRecord, saveVotingHotkey } from '../../services/voting/persistence';
import type { EncryptedVault } from './types';
import type { ZcashWalletJson } from '../wallets';
import type { WalletJson } from '@repo/wallet';
import { Key } from '@repo/encryption/key';
import { Box } from '@repo/encryption/box';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const OLD = 'the old password, long enough';
const NEW = 'a brand new password, also long';
const SEED = 'advance twist canal impact field normal depend pink sick horn world broccoli';
const CONTACTS = [{ id: 'c1', name: 'ama', addresses: [] }];

type LK = Parameters<typeof readEncrypted>[2];

/** one of every kind of secret zafu keeps under the password */
const seedEverything = async (store: TestStore) => {
  const kr = () => store.getState().keyRing;
  await kr().setPassword(OLD);
  const ids = {
    mnemonic: await kr().newMnemonicKey(SEED, 'hot'),
    // a raw base64 orchard fvk (not uview...), so no wasm decode is needed here
    zigner: await kr().addZignerUnencrypted(
      { viewingKey: 'em9yY2hhcmQtZnZr', accountIndex: 0, deviceId: 'dev-zigner' },
      'zigner',
    ),
    keystone: await kr().addZignerUnencrypted(
      {
        viewingKey: 'a2V5c3RvbmUtZnZr',
        accountIndex: 0,
        deviceId: 'keystone-1',
        coldSignerType: 'keystone',
      },
      'keystone',
    ),
    viewingKey: await kr().addZignerUnencrypted(
      {
        viewingKey: 'dmlld2luZy1rZXk=',
        accountIndex: 0,
        deviceId: 'viewkey-1',
        coldSignerType: 'viewing-key',
      },
      'watch',
    ),
    ledger: await kr().addLedgerUnencrypted(
      { address: 'u1ledgeraddress', accountIndex: 0, deviceId: 'ledger-1', mainnet: true },
      'ledger',
    ),
    frost: await kr().newFrostMultisigKey({
      label: 'pair',
      address: 'u1frost',
      orchardFvk: 'uview1frost',
      publicKeyPackage: 'pkp',
      threshold: 2,
      maxSigners: 3,
      relayUrl: 'https://relay.invalid',
      keyPackage: 'the-key-package',
      ephemeralSeed: 'the-ephemeral-seed',
    }),
  };
  await store.getState().wallets.addWallet({ label: 'penumbra', seedPhrase: SEED.split(' ') });
  await writeEncryptedDirect(localExtStorage, sessionExtStorage, 'contacts' as LK, CONTACTS);
  await saveVotingHotkey(localExtStorage, sessionExtStorage, 'w1', 'r1', 'hot-secret', 'pub');
  return ids;
};

/** open every secret with whatever key the session now holds */
const openEverything = async (
  store: TestStore,
  ids: Awaited<ReturnType<typeof seedEverything>>,
) => {
  const kr = store.getState().keyRing;
  expect(await kr.getMnemonic(ids.mnemonic)).toBe(SEED);

  const vaults = (await localExtStorage.get('vaults')) as EncryptedVault[];
  for (const id of [ids.zigner, ids.keystone, ids.viewingKey, ids.ledger]) {
    const vault = vaults.find(v => v.id === id)!;
    expect(JSON.parse(await decryptVault({ session: sessionExtStorage }, vault))).toBeTruthy();
  }
  expect(await kr.getMultisigSecrets(ids.frost)).toEqual({
    keyPackage: 'the-key-package',
    ephemeralSeed: 'the-ephemeral-seed',
  });

  const zcash = (await readEncrypted<ZcashWalletJson[]>(
    localExtStorage,
    sessionExtStorage,
    'zcashWallets' as LK,
  ))!;
  const ms = zcash.find(w => w.vaultId === ids.frost)!.multisig!;
  expect(
    await decryptMultisigSecrets({ session: sessionExtStorage }, ms.keyPackage!, ms.ephemeralSeed!),
  ).toEqual({ keyPackage: 'the-key-package', ephemeralSeed: 'the-ephemeral-seed' });

  const penumbra = (await readEncrypted<WalletJson[]>(
    localExtStorage,
    sessionExtStorage,
    'penumbraWallets' as LK,
  ))!;
  const key = await Key.fromJson((await sessionExtStorage.get('passwordKey'))!);
  const custody = penumbra.find(w => 'encryptedSeedPhrase' in w.custody)!.custody as {
    encryptedSeedPhrase: Parameters<typeof Box.fromJson>[0];
  };
  expect(await key.unseal(Box.fromJson(custody.encryptedSeedPhrase))).toBe(SEED);

  expect(await readEncrypted(localExtStorage, sessionExtStorage, 'contacts' as LK)).toEqual(
    CONTACTS,
  );
  expect(
    (await loadVotingRoundRecord(localExtStorage, sessionExtStorage, 'w1', 'r1'))?.hotkeySecretHex,
  ).toBe('hot-secret');
};

/** a new popup after the old one died: nothing in memory, no session key */
const restart = () => {
  sessionMock.clear();
  return create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
};

describe('keyRing.changePassword', () => {
  let store: TestStore;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    markHydrated();
    store = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('every secret opens under the new password, and the old one is refused', async () => {
    const ids = await seedEverything(store);
    expect(await store.getState().keyRing.changePassword(OLD, NEW)).toBe(true);
    await openEverything(store, ids);

    const fresh = restart();
    expect(await fresh.getState().keyRing.unlock(OLD)).toBe(false);
    expect(await fresh.getState().keyRing.unlock(NEW)).toBe(true);
    await openEverything(fresh, ids);
  });

  test('a wrong current password changes nothing', async () => {
    const ids = await seedEverything(store);
    const before = Object.fromEntries(localMock);
    expect(await store.getState().keyRing.changePassword('not it', NEW)).toBe(false);
    expect(Object.fromEntries(localMock)).toEqual(before);
    await openEverything(store, ids);
  });

  test('the in-memory wallets are the re-sealed ones', async () => {
    await seedEverything(store);
    await store.getState().keyRing.changePassword(OLD, NEW);
    expect((await store.getState().wallets.getSeedPhrase()).join(' ')).toBe(SEED);
  });

  // each failure point before the commit leaves the old password opening everything
  const beforeCommit: [string, () => void][] = [
    [
      'while re-sealing',
      () => {
        let n = 0;
        const seal = Key.prototype.seal;
        vi.spyOn(Key.prototype, 'seal').mockImplementation(function (this: Key, m: string) {
          if (++n === 4) {
            throw new Error('crash');
          }
          return seal.call(this, m);
        });
      },
    ],
    [
      'at the commit write',
      () => {
        const set = chrome.storage.local.set.bind(chrome.storage.local);
        vi.spyOn(chrome.storage.local, 'set').mockImplementation(((items: object) =>
          'passwordKeyPrint' in items
            ? Promise.reject(new Error('crash'))
            : set(items as Record<string, unknown>)) as typeof chrome.storage.local.set);
      },
    ],
  ];

  test.each(beforeCommit)('a crash %s leaves the old password working', async (_, inject) => {
    const ids = await seedEverything(store);
    inject();
    await expect(store.getState().keyRing.changePassword(OLD, NEW)).rejects.toThrow('crash');
    vi.restoreAllMocks();

    // the same popup is still unlocked under the old key
    await openEverything(store, ids);

    // and after a restart only the old password opens it
    const fresh = restart();
    expect(await fresh.getState().keyRing.unlock(NEW)).toBe(false);
    expect(await fresh.getState().keyRing.unlock(OLD)).toBe(true);
    await openEverything(fresh, ids);
  });

  test('a crash after the commit, before the session key, leaves the new password working', async () => {
    const ids = await seedEverything(store);
    const set = chrome.storage.session.set.bind(chrome.storage.session);
    let armed = true;
    vi.spyOn(chrome.storage.session, 'set').mockImplementation(((items: object) => {
      if (armed && 'passwordKey' in items) {
        armed = false;
        return Promise.reject(new Error('crash'));
      }
      return set(items as Record<string, unknown>);
    }) as typeof chrome.storage.session.set);
    await expect(store.getState().keyRing.changePassword(OLD, NEW)).rejects.toThrow('crash');
    vi.restoreAllMocks();

    const fresh = restart();
    expect(await fresh.getState().keyRing.unlock(OLD)).toBe(false);
    expect(await fresh.getState().keyRing.unlock(NEW)).toBe(true);
    await openEverything(fresh, ids);
  });

  test('nothing is sealed under the old key while the swap runs', async () => {
    await seedEverything(store);
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    let sessionDuringCommit: unknown = 'unset';
    vi.spyOn(chrome.storage.local, 'set').mockImplementation((async (items: object) => {
      if ('passwordKeyPrint' in items) {
        sessionDuringCommit = await sessionExtStorage.get('passwordKey');
      }
      return set(items as Record<string, unknown>);
    }) as typeof chrome.storage.local.set);
    await store.getState().keyRing.changePassword(OLD, NEW);
    expect(sessionDuringCommit).toBeUndefined();
  });
});
