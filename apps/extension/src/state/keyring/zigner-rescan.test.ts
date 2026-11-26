import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import type { EncryptedVault } from './types';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

// scanning a zigner that is already here meets the person's goal: it selects
// that wallet, adds nothing, and is never reported as a failure
describe('the same zigner scanned again', () => {
  let useStore: TestStore;
  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('selects the wallet it already made, and makes no second one', async () => {
    const kr = () => useStore.getState().keyRing;
    const code = { viewingKey: 'em9yY2hhcmQtZnZr', accountIndex: 0, deviceId: 'dev' };
    const first = await kr().addZignerUnencrypted(code, 'zigner');
    await kr().newMnemonicKey(
      'advance twist canal impact field normal depend pink sick horn world broccoli',
      'Wallet 1',
    );
    expect(kr().selectedKeyInfo?.id).not.toBe(first);

    await expect(kr().addZignerUnencrypted(code, 'zigner again')).resolves.toBe(first);
    const zigners = ((localMock.get('vaults') ?? []) as EncryptedVault[]).filter(
      v => v.type === 'zigner-zafu',
    );
    expect(zigners).toHaveLength(1);
    expect(kr().selectedKeyInfo?.id).toBe(first);
  });
});
