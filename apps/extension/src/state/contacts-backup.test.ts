import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '.';
import { restoreContacts, type Contact } from './contacts';
import { mintRelationshipIndex } from './identity';
import { readRooms, readThreads, writeRooms, writeThreads, THREAD_CAP } from '../people/vault';
import type { PeopleRoom, ThreadItem } from '../people/vault';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const card = { suite: 'x25519-v1' as const, publicKey: 'ab'.repeat(32) };

describe('personal-data backup keeps relationships', () => {
  let useStore: TestStore;

  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
  });

  test('an export/import round-trip keeps contact ids and cards', async () => {
    const { contacts } = useStore.getState();
    const bob = await contacts.addContact({ name: 'bob', card, zid: 'cd'.repeat(32) });
    await contacts.addAddress(bob.id, { network: 'zcash', address: 'u1bob' });
    const before = useStore.getState().contacts.contacts as Contact[];

    const backup = await useStore.getState().contacts.exportPersonalData('backup-pass');
    await useStore.getState().contacts.clearAll();
    const n = await useStore.getState().contacts.importPersonalData(backup, 'backup-pass', 'merge');

    expect(n.contacts).toBe(1);
    const after = useStore.getState().contacts.contacts as Contact[];
    expect(after).toEqual(before);
    expect(after[0]!.id).toBe(bob.id);
    expect(after[0]!.card).toEqual(card);
  });

  test('a second restore does not duplicate', async () => {
    await useStore.getState().contacts.addContact({ name: 'bob', card });
    const backup = await useStore.getState().contacts.exportPersonalData('backup-pass');
    const n = await useStore.getState().contacts.importPersonalData(backup, 'backup-pass', 'merge');
    expect(n.contacts).toBe(0);
    expect(useStore.getState().contacts.contacts).toHaveLength(1);
  });
});

describe('personal-data backup keeps people rooms', () => {
  let useStore: TestStore;

  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
  });

  const room: PeopleRoom = {
    id: 'g:00112233445566778899aabbccddeeff',
    walletId: 'w1',
    kind: 'group',
    name: 'treasury',
    appScope: 'zafu-group-v1',
    secret: '07'.repeat(32),
    size: 4096,
    relay: 'https://zcash.rotko.net',
    signer: { gen: 0, G: '00112233445566778899aabbccddeeff' },
    nick: 'alice',
    joined: true,
    createdAt: 1,
  };
  const item = (n: number): ThreadItem => ({
    hash: n.toString(16).padStart(64, '0'),
    author: 'ab'.repeat(32),
    name: 'bob',
    body: `line ${n}`,
    ts: 1_000 + n,
    epoch: 1,
    kind: 'msg',
    mine: false,
  });

  test('rooms, nicks and the newest 500 lines per thread survive a wipe', async () => {
    await writeRooms([room]);
    const items = Array.from({ length: THREAD_CAP + 20 }, (_, i) => item(i));
    await writeThreads({ 'w1/g:00112233445566778899aabbccddeeff': { items, read: 3 } });
    // rooms are sealed at rest like contacts
    expect(JSON.stringify(localMock.get('peopleRooms'))).not.toContain('treasury');

    const backup = await useStore.getState().contacts.exportPersonalData('backup-pass');
    await writeRooms([]);
    await writeThreads({});
    await useStore.getState().contacts.importPersonalData(backup, 'backup-pass', 'merge');

    expect(await readRooms()).toEqual([room]);
    const t = (await readThreads())!['w1/g:00112233445566778899aabbccddeeff']!;
    expect(t.items).toHaveLength(THREAD_CAP);
    expect(t.items[0]!.body).toBe('line 20');
    expect(t.read).toBe(3);
  });

  test('a backup made before people rooms restores and leaves them alone', async () => {
    await writeRooms([room]);
    const backup = await useStore.getState().contacts.exportPersonalData('backup-pass');
    // an older backup: same envelope, no people field (rooms empty at export)
    await writeRooms([]);
    const old = await useStore.getState().contacts.exportPersonalData('backup-pass');
    await writeRooms([room]);
    await useStore.getState().contacts.importPersonalData(old, 'backup-pass', 'merge');
    expect(await readRooms()).toEqual([room]);
    // and restoring twice never duplicates a room
    await useStore.getState().contacts.importPersonalData(backup, 'backup-pass', 'merge');
    expect(await readRooms()).toHaveLength(1);
  });
});

describe('restoreContacts', () => {
  test('an old backup without ids gets fresh ones and skips names already here', () => {
    const existing: Contact[] = [{ id: 'x', name: 'Bob', createdAt: 1, addresses: [] }];
    const restored = restoreContacts(
      [
        { name: 'bob', addresses: [] },
        { name: 'carol', addresses: [{ network: 'zcash', address: 'u1carol' }] },
      ],
      existing,
      'merge',
    );
    expect(restored.map(c => c.name)).toEqual(['carol']);
    expect(restored[0]!.id).toBeTruthy();
    expect(restored[0]!.addresses[0]!.id).toBeTruthy();
  });
});

describe('personal-data backup keeps the relationship counter', () => {
  const PHRASE =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  let useStore: TestStore;

  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
  });

  test('a restore on a fresh install never hands out a j already given', async () => {
    const id = await useStore.getState().keyRing.newMnemonicKey(PHRASE, 'main');
    // three cards shown (no contact for them), and a contact holding j 1
    for (let i = 0; i < 3; i++) {
      await mintRelationshipIndex(id, 0);
    }
    await useStore
      .getState()
      .contacts.addContact({ name: 'bob', rel: { walletId: id, gen: 0, j: 1 } });
    const backup = await useStore.getState().contacts.exportPersonalData('backup-pass');

    // a fresh install: storage wiped, the same seed imported under a new vault id
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
    const again = await useStore.getState().keyRing.newMnemonicKey(PHRASE, 'main');
    expect(again).not.toBe(id);
    await useStore.getState().contacts.importPersonalData(backup, 'backup-pass', 'merge');

    // the counter came back, and bob's relationship names the wallet it is on now
    expect(await mintRelationshipIndex(again, 0)).toBe(3);
    const bob = (useStore.getState().contacts.contacts as Contact[]).find(c => c.name === 'bob');
    expect(bob?.rel).toEqual({ walletId: again, gen: 0, j: 1 });
  });

  test('a contact holding a j past the backed-up counter raises it', async () => {
    const id = await useStore.getState().keyRing.newMnemonicKey(PHRASE, 'main');
    await useStore
      .getState()
      .contacts.addContact({ name: 'carol', rel: { walletId: id, gen: 2, j: 9 } });
    const backup = await useStore.getState().contacts.exportPersonalData('backup-pass');
    await chrome.storage.local.remove(`xidRelNext:${id}`);
    await useStore.getState().contacts.importPersonalData(backup, 'backup-pass', 'merge');
    expect(await mintRelationshipIndex(id, 2)).toBe(10);
    expect(await mintRelationshipIndex(id, 0)).toBe(0);
  });
});
