import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '.';
import { restoreContacts, type Contact } from './contacts';

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
