import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { selectEffectiveKeyInfo, selectKeyInfosForActiveNetwork, selectPenumbraOnly } from '.';
import { keyInfoSupportsNetwork } from './vault-ops';
import type { EncryptedVault, KeyInfo } from './types';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const TWELVE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TWENTY_FOUR = `${'abandon '.repeat(23)}art`;

const key = (insensitive: Record<string, unknown>): KeyInfo => ({
  id: 'v',
  name: 'w',
  type: 'mnemonic',
  isSelected: true,
  createdAt: 0,
  insensitive,
});

describe('keyInfoSupportsNetwork', () => {
  test('a phrase vault with no field supports every network', () => {
    expect(keyInfoSupportsNetwork(key({}), 'zcash')).toBe(true);
    expect(keyInfoSupportsNetwork(key({}), 'penumbra')).toBe(true);
  });

  test('a penumbra-only phrase vault never supports zcash', () => {
    const k = key({ supportedNetworks: ['penumbra'] });
    expect(keyInfoSupportsNetwork(k, 'zcash')).toBe(false);
    expect(keyInfoSupportsNetwork(k, 'penumbra')).toBe(true);
  });
});

describe('a 12-word phrase is penumbra-only', () => {
  let useStore: TestStore;
  const kr = () => useStore.getState().keyRing;
  const vault = (id: string) =>
    ((localMock.get('vaults') ?? []) as EncryptedVault[]).find(v => v.id === id)!;

  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await kr().setPassword('s0meUs3rP@ssword');
  });

  test('the vault records it; a 24-word vault carries no field', async () => {
    const twelve = await kr().newMnemonicKey(TWELVE, 'p');
    const full = await kr().newMnemonicKey(TWENTY_FOUR, 'z');
    expect(vault(twelve).insensitive['supportedNetworks']).toEqual(['penumbra']);
    expect(vault(full).insensitive['supportedNetworks']).toBeUndefined();
  });

  test('a re-import selects the same vault and leaves its fields alone', async () => {
    const id = await kr().newMnemonicKey(TWELVE, 'p');
    const before = structuredClone(vault(id));
    await kr().newMnemonicKey(TWENTY_FOUR, 'z');
    expect(await kr().newMnemonicKey(TWELVE, 'again')).toBe(id);
    expect(vault(id)).toEqual(before);
    expect(kr().selectedKeyInfo?.id).toBe(id);
  });

  test('zcash never selects it, penumbra does', async () => {
    const full = await kr().newMnemonicKey(TWENTY_FOUR, 'z');
    const twelve = await kr().newMnemonicKey(TWELVE, 'p');
    await kr().setActiveNetwork('penumbra');
    expect(selectEffectiveKeyInfo(useStore.getState())?.id).toBe(twelve);

    useStore.setState(s => {
      s.keyRing.activeNetwork = 'zcash';
    });
    expect(selectEffectiveKeyInfo(useStore.getState())?.id).toBe(full);
    expect(selectKeyInfosForActiveNetwork(useStore.getState()).map(k => k.id)).toEqual([full]);

    // switching to zcash moves the selection to a wallet that can hold it
    await kr().setActiveNetwork('penumbra');
    await kr().selectKeyRing(twelve);
    await kr().setActiveNetwork('zcash');
    expect(kr().selectedKeyInfo?.id).toBe(full);
  });

  test('with no other wallet, zcash has none to show', async () => {
    await kr().newMnemonicKey(TWELVE, 'p');
    useStore.setState(s => {
      s.keyRing.activeNetwork = 'zcash';
    });
    expect(selectEffectiveKeyInfo(useStore.getState())).toBeUndefined();
    expect(selectPenumbraOnly(useStore.getState())).toBe(true);
  });

  test('a 24-word wallet is never penumbra-only', async () => {
    await kr().newMnemonicKey(TWENTY_FOUR, 'z');
    expect(selectPenumbraOnly(useStore.getState())).toBe(false);
  });
});
