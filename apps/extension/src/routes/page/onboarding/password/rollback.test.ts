import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore } from '../../../../state';
import {
  markHydrated,
  readEncrypted,
  writeEncryptedDirect,
} from '../../../../state/encrypted-storage';
import { restoreSnapshot } from './hooks';
import { legacyAirgapProfile } from '../../../../state/keyring/legacy-airgap.test-util';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;
type LK = Parameters<typeof readEncrypted>[2];

// a failed import must put the keyprint back with the data it sealed
describe('onboarding rollback', () => {
  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    markHydrated();
  });

  test('a first password on an airgap-only profile is undone, other writes kept', async () => {
    const store = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    const kr = () => store.getState().keyRing;
    const id = await legacyAirgapProfile(store, {
      viewingKey: 'em9yY2hhcmQtZnZr',
      accountIndex: 0,
      deviceId: 'dev',
    });
    await writeEncryptedDirect(localExtStorage, sessionExtStorage, 'contacts' as LK, [{ id: 'a' }]);
    const snapshot = await chrome.storage.local.get(null);
    const { passwordKey } = await chrome.storage.session.get('passwordKey');

    await kr().setPassword('the first real password'); // moves every store
    // another context writes meanwhile; the undo must leave that standing
    await writeEncryptedDirect(localExtStorage, sessionExtStorage, 'contacts' as LK, [
      { id: 'a' },
      { id: 'b' },
    ]);
    await kr().newMnemonicKey(
      'advance twist canal impact field normal depend pink sick horn world broccoli',
      'hot',
    );
    await restoreSnapshot(snapshot, passwordKey); // and then the import failed

    const fresh = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    sessionMock.clear();
    expect(await fresh.getState().keyRing.unlock('the first real password')).toBe(false);
    // back to the old profile: nothing opens it until it is given a password (#160)
    expect(await fresh.getState().keyRing.unlock('')).toBe(false);
    await fresh.getState().keyRing.init();
    expect(fresh.getState().keyRing.needsPassword).toBe(true);
    await fresh.getState().keyRing.setPassword('a later password');
    expect(((await localExtStorage.get('vaults')) ?? []).map(v => v.id)).toEqual([id]);
    expect(await readEncrypted(localExtStorage, sessionExtStorage, 'contacts' as LK)).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
  });

  test('an import on a profile with a password puts back only what it wrote', async () => {
    const store = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await store.getState().keyRing.setPassword('pw pw pw pw');
    const id = await store
      .getState()
      .keyRing.newMnemonicKey(
        'advance twist canal impact field normal depend pink sick horn world broccoli',
        'hot',
      );
    const snapshot = await chrome.storage.local.get(null);
    const { passwordKey } = await chrome.storage.session.get('passwordKey');
    await store
      .getState()
      .keyRing.addZignerUnencrypted(
        { viewingKey: 'em9yY2hhcmQtZnZr', accountIndex: 0, deviceId: 'dev' },
        'zigner',
      );
    await restoreSnapshot(snapshot, passwordKey);
    expect(((await localExtStorage.get('vaults')) ?? []).map(v => v.id)).toEqual([id]);
    expect(await store.getState().keyRing.getMnemonic(id)).toMatch(/^advance/);
  });
});
