import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore, TestStore } from '..';
import { viewingKeyImport } from '../../hooks/use-viewing-key';
import { fullNetworks } from './wallet-limit';

// the persistence boundary runs the wasm UFVK decode; the keys here are stand-ins
vi.mock('@repo/zcash-wasm', () => ({ default: async () => undefined, validate_ufvk: () => true }));

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const ufvk = (c: string) => 'uview1' + c.repeat(200);
const ZID = 'ab'.repeat(32);

describe('which networks are full', () => {
  const phrase = { type: 'mnemonic', insensitive: {} };
  const zcash = { type: 'zigner-zafu', insensitive: { supportedNetworks: ['zcash'] } };

  test('a phrase wallet counts for every network, a signer for its own', () => {
    expect(fullNetworks([phrase, zcash], ['zcash', 'penumbra'])).toEqual(['zcash']);
    expect(fullNetworks([phrase, phrase], ['penumbra'])).toEqual(['penumbra']);
    expect(fullNetworks([phrase], ['zcash', 'penumbra'])).toEqual([]);
  });

  test('a shared wallet and a hidden app table are not counted', () => {
    const frost = { type: 'frost-multisig', insensitive: {} };
    const hidden = { ...zcash, insensitive: { ...zcash.insensitive, hidden: true } };
    expect(fullNetworks([zcash, frost, hidden], ['zcash'])).toEqual([]);
  });
});

describe('at most two wallets per network', () => {
  let useStore: TestStore;
  const kr = () => useStore.getState().keyRing;

  beforeEach(() => {
    localMock.clear();
    sessionMock.clear();
    useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
  });

  test('a third zcash wallet is refused, and nothing is written', async () => {
    await kr().addZignerUnencrypted(await viewingKeyImport(ufvk('x')), 'one');
    await kr().addZignerUnencrypted(await viewingKeyImport(ufvk('y')), 'two');
    await expect(
      kr().addZignerUnencrypted(await viewingKeyImport(ufvk('z')), 'three'),
    ).rejects.toThrow('zafu holds up to two zcash wallets · please remove one to add another');
    expect(kr().keyInfos).toHaveLength(2);
  });

  test('a signer joining its wallet with a network at its limit is refused', async () => {
    await kr().addZignerUnencrypted(
      { fullViewingKey: 'penumbra-fvk', accountIndex: 0, deviceId: ZID, zidPublicKey: ZID },
      'zigner',
    );
    await kr().addZignerUnencrypted(await viewingKeyImport(ufvk('x')), 'one');
    await kr().addZignerUnencrypted(await viewingKeyImport(ufvk('y')), 'two');
    await expect(
      kr().addZignerUnencrypted(
        {
          viewingKey: ufvk('z'),
          accountIndex: 0,
          deviceId: ZID,
          zidPublicKey: ZID,
          coldSignerType: 'zigner',
        },
        'zigner zcash',
      ),
    ).rejects.toThrow('zafu holds up to two zcash wallets');
  });

  test('the same code scanned again says it is already here', async () => {
    const zigner = {
      viewingKey: ufvk('x'),
      accountIndex: 0,
      deviceId: ZID,
      zidPublicKey: ZID,
      coldSignerType: 'zigner' as const,
    };
    await kr().addZignerUnencrypted(zigner, 'zigner zcash');
    await expect(kr().addZignerUnencrypted(zigner, 'zigner zcash')).rejects.toThrow(
      'this zigner wallet is already imported',
    );
    expect(kr().keyInfos).toHaveLength(1);
  });
});
