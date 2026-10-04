import { beforeEach, describe, expect, test, vi } from 'vitest';
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

describe('networks slice: what kind of zcash node', () => {
  const create_ = () => create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
  });

  test('a kind stored by an older build is the initial value until the node answers', async () => {
    localMock.set('dbVersion', 5);
    localMock.set('networkEndpoints', { zcash: 'https://lwd.example.org' });
    localMock.set('zcashBackend', 'zidecar');
    const useStore = create_();
    await vi.waitFor(() =>
      expect(useStore.getState().networks.networks.zcash.endpoint).toBe('https://lwd.example.org'),
    );
    const zcash = useStore.getState().networks.networks.zcash;
    expect(zcash.backend).toBe('zidecar');
    expect(zcash.backendDetected).toBeFalsy();

    // detection corrects it, and the answer is cached for that node
    await useStore.getState().networks.noteZcashBackend('https://lwd.example.org/', 'lightwalletd');
    expect(useStore.getState().networks.networks.zcash).toMatchObject({
      backend: 'lightwalletd',
      backendDetected: true,
    });
    expect(await localExtStorage.get('zcashBackends')).toEqual({
      'https://lwd.example.org': 'lightwalletd',
    });
    expect(await localExtStorage.get('zcashBackend')).toBe('lightwalletd');
  });

  test("the node's cached answer wins over a stored kind, per endpoint", async () => {
    localMock.set('dbVersion', 5);
    localMock.set('networkEndpoints', { zcash: 'https://mine.example.org' });
    localMock.set('zcashBackend', 'lightwalletd');
    localMock.set('zcashBackends', { 'https://mine.example.org': 'zidecar' });
    const useStore = create_();
    await vi.waitFor(() =>
      expect(useStore.getState().networks.networks.zcash.backendDetected).toBe(true),
    );
    expect(useStore.getState().networks.networks.zcash.backend).toBe('zidecar');

    // a node never asked starts from the guess, which is never zidecar for a third party
    await useStore.getState().networks.setNetworkEndpoint('zcash', 'https://other.example.org');
    expect(useStore.getState().networks.networks.zcash).toMatchObject({
      backend: 'lightwalletd',
      backendDetected: false,
    });
    // and going back finds the earlier answer without asking
    await useStore.getState().networks.setNetworkEndpoint('zcash', 'https://mine.example.org');
    expect(useStore.getState().networks.networks.zcash).toMatchObject({
      backend: 'zidecar',
      backendDetected: true,
    });
  });

  test("an answer about another node is cached but leaves the current node's kind alone", async () => {
    const useStore = create_();
    await useStore
      .getState()
      .networks.noteZcashBackend('https://elsewhere.example', 'lightwalletd');
    expect(useStore.getState().networks.networks.zcash.backend).toBe('zidecar');
    expect(await localExtStorage.get('zcashBackends')).toEqual({
      'https://elsewhere.example': 'lightwalletd',
    });
  });

  test('the worker relays an answer through the page event', async () => {
    const useStore = create_();
    window.dispatchEvent(
      new CustomEvent('zcash-backend-detected', {
        detail: { serverUrl: 'https://zcash.rotko.net', backend: 'lightwalletd' },
      }),
    );
    await vi.waitFor(() =>
      expect(useStore.getState().networks.networks.zcash.backend).toBe('lightwalletd'),
    );
  });
});
