import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '.';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

describe('networks slice: disableNetwork', () => {
  let useStore: TestStore;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('disables and persists even when a vault declares the network', async () => {
    // Vault metadata naming the target network is the only "wallet uses this
    // network" signal that exists (wallets/zcashWallets carry no network id),
    // and it does NOT gate disable - toggling a network off is always allowed.
    localMock.set('vaults', [
      { id: 'v1', type: 'mnemonic', insensitive: { supportedNetworks: ['zcash'] } },
    ]);

    await useStore.getState().networks.enableNetwork('zcash');
    expect(useStore.getState().networks.networks.zcash.enabled).toBe(true);

    await expect(useStore.getState().networks.disableNetwork('zcash')).resolves.toBeUndefined();

    expect(useStore.getState().networks.networks.zcash.enabled).toBe(false);
    expect(await localExtStorage.get('enabledNetworks')).not.toContain('zcash');
  });

  test('disables and flips the flag with an unrelated vault present', async () => {
    localMock.set('vaults', [
      { id: 'v2', type: 'mnemonic', insensitive: { supportedNetworks: ['penumbra'] } },
    ]);

    await useStore.getState().networks.enableNetwork('zcash');
    expect(useStore.getState().networks.networks.zcash.enabled).toBe(true);

    await useStore.getState().networks.disableNetwork('zcash');

    expect(useStore.getState().networks.networks.zcash.enabled).toBe(false);
    const stored = await localExtStorage.get('enabledNetworks');
    expect(stored).toEqual([]);
  });
});
