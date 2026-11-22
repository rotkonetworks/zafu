import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { selectEffectiveKeyInfo, selectKeyInfosForActiveNetwork, selectPenumbraOnly } from '.';
import { keyInfoSupportsNetwork, vaultsToKeyInfos } from './vault-ops';
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

describe('12-word phrases', () => {
  let useStore: TestStore;
  const kr = () => useStore.getState().keyRing;
  const vault = (id: string) =>
    ((localMock.get('vaults') ?? []) as EncryptedVault[]).find(v => v.id === id)!;

  const markPenumbraOnly = (id: string) => {
    const vaults = (localMock.get('vaults') ?? []) as EncryptedVault[];
    const v = vaults.find(x => x.id === id)!;
    v.insensitive = { ...v.insensitive, supportedNetworks: ['penumbra'] };
    localMock.set('vaults', vaults);
    useStore.setState(s => {
      s.keyRing.keyInfos = vaultsToKeyInfos(vaults, s.keyRing.selectedKeyInfo?.id);
      const sel = s.keyRing.keyInfos.find(k => k.id === s.keyRing.selectedKeyInfo?.id);
      if (sel) {
        s.keyRing.selectedKeyInfo = sel;
      }
    });
  };

  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await kr().setPassword('s0meUs3rP@ssword');
  });

  test('a new 12-word import serves every network, like 24 words', async () => {
    const twelve = await kr().newMnemonicKey(TWELVE, 'p');
    expect(vault(twelve).insensitive['supportedNetworks']).toBeUndefined();
    useStore.setState(s => {
      s.keyRing.activeNetwork = 'zcash';
    });
    expect(selectEffectiveKeyInfo(useStore.getState())?.id).toBe(twelve);
    expect(selectPenumbraOnly(useStore.getState())).toBe(false);

    const full = await kr().newMnemonicKey(TWENTY_FOUR, 'z');
    expect(vault(full).insensitive['supportedNetworks']).toBeUndefined();
    expect(keyInfoSupportsNetwork(kr().keyInfos.find(k => k.id === twelve)!, 'zcash')).toBe(true);
  });

  test('a re-import selects the same vault and does not duplicate it', async () => {
    const id = await kr().newMnemonicKey(TWELVE, 'p');
    const before = structuredClone(vault(id));
    await kr().newMnemonicKey(TWENTY_FOUR, 'z');
    expect(await kr().newMnemonicKey(TWELVE, 'again')).toBe(id);
    expect(vault(id)).toEqual(before);
    expect(kr().selectedKeyInfo?.id).toBe(id);
  });

  test('re-importing a penumbra-only vault lifts the limit, seed untouched', async () => {
    const id = await kr().newMnemonicKey(TWELVE, 'p');
    markPenumbraOnly(id);
    expect(vault(id).insensitive['supportedNetworks']).toEqual(['penumbra']);
    const before = structuredClone(vault(id));
    expect(await kr().newMnemonicKey(TWELVE, 'again')).toBe(id);
    const after = vault(id);
    expect(after.insensitive['supportedNetworks']).toBeUndefined();
    expect([after.encryptedData, after.salt, after.insensitive['zid']]).toEqual([
      before.encryptedData,
      before.salt,
      before.insensitive['zid'],
    ]);
    expect(kr().keyInfos.find(k => k.id === id)?.insensitive['supportedNetworks']).toBeUndefined();
    useStore.setState(s => {
      s.keyRing.activeNetwork = 'zcash';
    });
    expect(selectEffectiveKeyInfo(useStore.getState())?.id).toBe(id);
  });

  test('a legacy penumbra-only vault is not selected on zcash until re-imported', async () => {
    const full = await kr().newMnemonicKey(TWENTY_FOUR, 'z');
    const twelve = await kr().newMnemonicKey(TWELVE, 'p');
    markPenumbraOnly(twelve);
    await kr().setActiveNetwork('penumbra');
    expect(selectEffectiveKeyInfo(useStore.getState())?.id).toBe(twelve);

    useStore.setState(s => {
      s.keyRing.activeNetwork = 'zcash';
    });
    expect(selectEffectiveKeyInfo(useStore.getState())?.id).toBe(full);
    expect(selectKeyInfosForActiveNetwork(useStore.getState()).map(k => k.id)).toEqual([full]);

    await kr().setActiveNetwork('penumbra');
    await kr().selectKeyRing(twelve);
    await kr().setActiveNetwork('zcash');
    expect(kr().selectedKeyInfo?.id).toBe(full);
  });

  test('with only a legacy penumbra-only vault, zcash has none to show', async () => {
    const id = await kr().newMnemonicKey(TWELVE, 'p');
    markPenumbraOnly(id);
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
