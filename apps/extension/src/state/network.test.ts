import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '.';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

describe('Network Slice', () => {
  let useStore: TestStore;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('the default is empty, false or undefined', () => {
    expect(useStore.getState().network.grpcEndpoint).toBeUndefined();
    expect(useStore.getState().network.fullSyncHeight).toBeUndefined();
  });

  describe('setGRPCEndpoint', () => {
    test('grpc endpoint can be set', async () => {
      const testUrl = 'https://test';
      await useStore.getState().network.setGRPCEndpoint(testUrl);

      expect(useStore.getState().network.grpcEndpoint).toBe(testUrl);
      const urlFromChromeStorage = await localExtStorage.get('grpcEndpoint');
      expect(urlFromChromeStorage).toBe(testUrl);
    });
  });
});
