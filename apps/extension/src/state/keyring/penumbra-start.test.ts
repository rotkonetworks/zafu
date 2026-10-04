import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

describe('a new wallet and its penumbra start', () => {
  const seedA =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seedB = 'advance twist canal impact field normal depend pink sick horn world broccoli';
  let useStore: TestStore;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('a phrase zafu generated starts at the tip; an imported one is asked', async () => {
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
    await useStore.getState().keyRing.newMnemonicKey(seedA, 'generated', true);
    const starts = (await localExtStorage.get('penumbraStarts')) ?? {};
    expect(Object.values(starts)).toEqual(['tip']);

    await useStore.getState().keyRing.newMnemonicKey(seedB, 'imported');
    expect(await localExtStorage.get('penumbraStarts')).toEqual(starts);
  });

  test('a phrase already here keeps its start: generating it again writes nothing', async () => {
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
    await useStore.getState().keyRing.newMnemonicKey(seedA, 'first');
    await useStore.getState().keyRing.newMnemonicKey(seedA, 'again', true);
    expect(await localExtStorage.get('penumbraStarts')).toBeUndefined();
  });

  test('removing a wallet removes its start and keeps the others', async () => {
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
    const ids = async () => Object.keys((await localExtStorage.get('penumbraStarts')) ?? {});
    const vaultA = await useStore.getState().keyRing.newMnemonicKey(seedA, 'a', true);
    const [idA] = await ids();
    await useStore.getState().keyRing.newMnemonicKey(seedB, 'b', true);
    const idB = (await ids()).find(id => id !== idA);

    await useStore.getState().keyRing.deleteKeyRing(vaultA);
    expect(await ids()).toEqual([idB]);
  });
});
