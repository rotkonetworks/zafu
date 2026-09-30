import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { createEncryptedLocal } from '../encrypted-storage';
import { zcashSyncHeightKey } from './network-worker';
import type { ZcashWalletJson } from '../wallets';

// zcashWallets is stored encrypted-at-rest (see ENCRYPTED_KEYS in
// encrypted-storage.ts) - write it through the same wrapper the store uses,
// not raw localExtStorage, or the keyring's read of it decrypts nothing.
const encryptedLocal = createEncryptedLocal(localExtStorage, sessionExtStorage);

const deleteWalletInWorkerMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./network-worker', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, deleteWalletInWorker: deleteWalletInWorkerMock };
});

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const zidPinsKey = (walletId: string) => `zidPins:${walletId}`;

// Regression: deleteKeyRing removed the vault but left per-wallet data behind
// in several other storage keys (zidPins:<walletId>, legacy zignerWallets
// plaintext-FVK records, zidGenKeys, the zcash worker/birthday key). Removing
// one wallet among several must delete everything that belongs to it, without
// touching another wallet's equivalent data.
describe('keyRing.deleteKeyRing purges per-wallet data', () => {
  const password = 's0meUs3rP@ssword';
  const seedA = [
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ];
  const seedB = ['advance twist canal impact field normal depend pink sick horn world broccoli'];

  let useStore: TestStore;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    deleteWalletInWorkerMock.mockClear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('removing one of two wallets deletes its zidPins, leaves the other wallet intact', async () => {
    await useStore.getState().keyRing.setPassword(password);
    const vaultA = await useStore.getState().keyRing.newMnemonicKey(seedA.join(' '), 'Wallet A');
    const vaultB = await useStore.getState().keyRing.newMnemonicKey(seedB.join(' '), 'Wallet B');

    // seed per-wallet ZID pins directly (mirrors state/identity.ts addZidPin)
    await chrome.storage.local.set({
      [zidPinsKey(vaultA)]: [{ index: 0, label: 'a-pin' }],
      [zidPinsKey(vaultB)]: [{ index: 0, label: 'b-pin' }],
    });
    // and a display cache that must be cleared on any wallet removal
    await chrome.storage.local.set({ zidGenKeys: { 0: 'deadbeef' } });

    // a legacy zignerWallets record whose FVK matches a zcash wallet we
    // attach to vault A below, plus one unrelated record that must survive
    const zcashWalletA: ZcashWalletJson = {
      id: 'zcash-a',
      label: 'zcash a',
      orchardFvk: 'uviewFVK_A',
      address: '',
      accountIndex: 0,
      mainnet: true,
      vaultId: vaultA,
    };
    const zcashWalletB: ZcashWalletJson = {
      id: 'zcash-b',
      label: 'zcash b',
      orchardFvk: 'uviewFVK_B',
      address: '',
      accountIndex: 0,
      mainnet: true,
      vaultId: vaultB,
    };
    await encryptedLocal.set('zcashWallets', [zcashWalletA, zcashWalletB]);

    // other per-wallet leftovers, one set per vault, that must also be purged
    // (or survive, for vault B) alongside zidPins/zignerWallets
    await chrome.storage.local.set({
      [zcashSyncHeightKey('zcash-a')]: 123,
      [zcashSyncHeightKey('zcash-b')]: 456,
      [`zcashTAddrs:${vaultA}`]: ['t1a'],
      [`zcashTAddrs:${vaultB}`]: ['t1b'],
      [`nobleShownIndices:${vaultA}`]: [0, 1],
      [`nobleShownIndices:${vaultB}`]: [0],
    });

    await localExtStorage.set('zignerWallets', [
      {
        id: 'legacy-a',
        label: 'legacy a',
        zignerAccountIndex: 0,
        importedAt: 0,
        networks: { zcash: { orchardFvk: 'uviewFVK_A', unifiedAddress: '', mainnet: true } },
      },
      {
        id: 'legacy-b',
        label: 'legacy b',
        zignerAccountIndex: 0,
        importedAt: 0,
        networks: { zcash: { orchardFvk: 'uviewFVK_B', unifiedAddress: '', mainnet: true } },
      },
    ]);

    await useStore.getState().keyRing.deleteKeyRing(vaultA);

    // vault A's pin key is gone, vault B's survives untouched
    expect(await chrome.storage.local.get(zidPinsKey(vaultA))).toEqual({});
    const remainingBPins = await chrome.storage.local.get(zidPinsKey(vaultB));
    expect(remainingBPins[zidPinsKey(vaultB)]).toEqual([{ index: 0, label: 'b-pin' }]);

    // the generation-key display cache is cleared (best-effort, unattributed cache)
    expect(await chrome.storage.local.get('zidGenKeys')).toEqual({});

    // legacy zignerWallets: only the FVK-matching record for the removed
    // wallet is gone; the unrelated record for vault B is untouched
    const zignerWallets = (await localExtStorage.get('zignerWallets')) ?? [];
    expect(zignerWallets.map(w => w.id)).toEqual(['legacy-b']);

    // zcashWallets: vault A's entry is gone, vault B's remains
    const zcashWallets = (await encryptedLocal.get('zcashWallets')) ?? [];
    expect(zcashWallets.map(w => w.id)).toEqual(['zcash-b']);

    // the zcash worker was told to delete vault A's zcash wallet record
    expect(deleteWalletInWorkerMock).toHaveBeenCalledWith('zcash', 'zcash-a');
    expect(deleteWalletInWorkerMock).not.toHaveBeenCalledWith('zcash', 'zcash-b');

    // sync-height hint (keyed by zcash wallet id, not vaultId): A gone, B kept
    expect(await chrome.storage.local.get(zcashSyncHeightKey('zcash-a'))).toEqual({});
    const bHeight = await chrome.storage.local.get(zcashSyncHeightKey('zcash-b'));
    expect(bHeight[zcashSyncHeightKey('zcash-b')]).toBe(456);

    // transparent-chain leftovers (keyed by vaultId): A gone, B kept
    expect(await chrome.storage.local.get(`zcashTAddrs:${vaultA}`)).toEqual({});
    const bAddrs = await chrome.storage.local.get(`zcashTAddrs:${vaultB}`);
    expect(bAddrs[`zcashTAddrs:${vaultB}`]).toEqual(['t1b']);

    expect(await chrome.storage.local.get(`nobleShownIndices:${vaultA}`)).toEqual({});
    const bShown = await chrome.storage.local.get(`nobleShownIndices:${vaultB}`);
    expect(bShown[`nobleShownIndices:${vaultB}`]).toEqual([0]);
  });

  test('a purgeWalletData failure leaves the vault in place, so the delete can be retried', async () => {
    await useStore.getState().keyRing.setPassword(password);
    const vaultA = await useStore.getState().keyRing.newMnemonicKey(seedA.join(' '), 'Wallet A');
    await useStore.getState().keyRing.newMnemonicKey(seedB.join(' '), 'Wallet B');

    const zcashWalletA: ZcashWalletJson = {
      id: 'zcash-fail',
      label: 'zcash a',
      orchardFvk: 'uviewFVK_FAIL',
      address: '',
      accountIndex: 0,
      mainnet: true,
      vaultId: vaultA,
    };
    await encryptedLocal.set('zcashWallets', [zcashWalletA]);

    // deleteWalletInWorker failures are already caught inside purgeWalletData
    // (worker may not be running), so simulate a harder failure instead: make
    // the vault-record write itself throw. removeLinkedWallets runs before
    // `local.set('vaults', ...)`, so this proves the ordering: the vault is
    // untouched, ready for another deleteKeyRing call.
    const originalSet = localExtStorage.set.bind(localExtStorage);
    const setSpy = vi
      .spyOn(localExtStorage, 'set')
      .mockImplementation(async (key: unknown, value: unknown) => {
        if (key === 'zcashWallets') {
          throw new Error('simulated storage failure');
        }
        return originalSet(key as never, value as never);
      });

    await expect(useStore.getState().keyRing.deleteKeyRing(vaultA)).rejects.toThrow(
      'simulated storage failure',
    );
    setSpy.mockRestore();

    const vaults = (await localExtStorage.get('vaults')) ?? [];
    expect(vaults.some(v => v.id === vaultA)).toBe(true);
  });

  test('removing the last wallet nukes everything, including per-wallet keys', async () => {
    await useStore.getState().keyRing.setPassword(password);
    const vaultA = await useStore.getState().keyRing.newMnemonicKey(seedA.join(' '), 'Wallet A');
    await chrome.storage.local.set({ [zidPinsKey(vaultA)]: [{ index: 0, label: 'a-pin' }] });

    await useStore.getState().keyRing.deleteKeyRing(vaultA);

    expect(await chrome.storage.local.get(zidPinsKey(vaultA))).toEqual({});
    // the full-nuke path wipes everything not in NUKE_SURVIVORS wholesale,
    // so 'vaults' is gone entirely rather than reset to an empty array
    expect(await localExtStorage.get('vaults')).toBeUndefined();
  });
});
