import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { viewingKeyImport } from '../../hooks/use-viewing-key';
import { custodyOf } from '../../components/custody-badge';
import { isViewOnly, walletKind } from '../../signing/wallet-kind';

// the persistence boundary runs the wasm UFVK decode; the key here is a stand-in
vi.mock('@repo/zcash-wasm', () => ({ default: async () => undefined, validate_ufvk: () => true }));

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const UFVK = 'uview1' + 'x'.repeat(200);
const ZID = 'ab'.repeat(32);
const zigner = { viewingKey: UFVK, accountIndex: 0, deviceId: ZID, zidPublicKey: ZID };

describe('a signer scanned for a viewing key already here', () => {
  let useStore: TestStore;
  const kr = () => useStore.getState().keyRing;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('joins that wallet, and every label reads it as the signer it now has', async () => {
    const id = await kr().addZignerUnencrypted(await viewingKeyImport(UFVK), 'savings');
    const before = kr().keyInfos.find(k => k.id === id)!;
    expect(isViewOnly(before)).toBe(true);
    expect(custodyOf(before)).toBe('watching');

    const merged = await kr().addZignerUnencrypted(
      { ...zigner, coldSignerType: 'zigner' },
      'zigner zcash',
    );

    expect(merged).toBe(id);
    expect(kr().keyInfos).toHaveLength(1);
    const after = kr().keyInfos[0]!;
    expect(after.name).toBe('savings');
    expect(after.insensitive['zid']).toBe(ZID);
    expect(walletKind(after)).toBe('zigner');
    expect(isViewOnly(after)).toBe(false);
    expect(custodyOf(after)).toBe('cold');
  });

  test('a keystone for the same key makes it a keystone wallet', async () => {
    const id = await kr().addZignerUnencrypted(await viewingKeyImport(UFVK), 'savings');
    await kr().addZignerUnencrypted(
      { viewingKey: UFVK, accountIndex: 0, deviceId: 'keystone-1', coldSignerType: 'keystone' },
      'keystone zcash',
    );
    expect(walletKind(kr().keyInfos.find(k => k.id === id)!)).toBe('keystone');
  });

  test('a viewing key never downgrades a signer, and a second copy is still refused', async () => {
    await kr().addZignerUnencrypted({ ...zigner, coldSignerType: 'zigner' }, 'zigner zcash');
    await expect(
      kr().addZignerUnencrypted(await viewingKeyImport(UFVK), 'savings'),
    ).rejects.toThrow('already exists');
    expect(kr().keyInfos).toHaveLength(1);
    expect(walletKind(kr().keyInfos[0]!)).toBe('zigner');
  });

  test('a signer for another key is a wallet of its own', async () => {
    await kr().addZignerUnencrypted(await viewingKeyImport(UFVK), 'savings');
    await kr().addZignerUnencrypted(
      { ...zigner, viewingKey: 'uview1' + 'y'.repeat(200), coldSignerType: 'zigner' },
      'zigner zcash',
    );
    expect(
      kr()
        .keyInfos.map(k => custodyOf(k))
        .sort(),
    ).toEqual(['cold', 'watching']);
  });
});

test('custody reads the signer a vault holds, not its storage type', () => {
  const vault = (type: string, cold?: string) =>
    ({ type, insensitive: cold ? { coldSignerType: cold } : {} }) as Parameters<
      typeof custodyOf
    >[0];
  expect(custodyOf(vault('mnemonic'))).toBe('hot');
  expect(custodyOf(vault('frost-multisig'))).toBe('shared');
  expect(custodyOf(vault('zigner-zafu'))).toBe('cold');
  expect(custodyOf(vault('zigner-zafu', 'ledger'))).toBe('cold');
  expect(custodyOf(vault('zigner-zafu', 'viewing-key'))).toBe('watching');
});
