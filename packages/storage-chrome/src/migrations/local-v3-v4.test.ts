import { MockStorageArea } from '@repo/mock-chrome/mocks/storage-area';
import { beforeEach, describe, expect, test } from 'vitest';
import { ExtensionStorage, ExtensionStorageDefaults } from '../base';
import { VERSION_FIELD } from '../version-field';
import * as Storage_V4 from '../versions/v4';
import local_v0_v1 from './local-v0-v1';
import local_v1_v2 from './local-v1-v2';
import local_v2_v3 from './local-v2-v3';
import local_v3_v4 from './local-v3-v4';

const defaultData: ExtensionStorageDefaults<Storage_V4.LOCAL> = {
  penumbraWallets: [],
  knownSites: [],
  numeraires: [],
};

const storageArea = new MockStorageArea();
let v4ExtStorage: ExtensionStorage<Storage_V4.LOCAL, Storage_V4.VERSION>;

describe('local-v3-v4 migration (drop polkadot/kusama)', () => {
  beforeEach(async () => {
    await storageArea.clear();

    v4ExtStorage = new ExtensionStorage<Storage_V4.LOCAL, Storage_V4.VERSION>(
      storageArea,
      defaultData,
      4,
      { 0: local_v0_v1, 1: local_v1_v2, 2: local_v2_v3, 3: local_v3_v4 },
    );
  });

  test('a vault holding zcash + polkadot capabilities keeps zcash and the vault itself', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 3,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      vaults: [
        {
          id: 'vault-1',
          type: 'zigner-zafu',
          name: 'zigner',
          createdAt: 1,
          encryptedData: 'enc',
          salt: '',
          insensitive: { supportedNetworks: ['zcash', 'polkadot'] },
        },
      ],
      zignerWallets: [
        {
          id: 'zw-1',
          label: 'zigner',
          zignerAccountIndex: 0,
          importedAt: 1,
          networks: {
            zcash: { orchardFvk: 'fvk', unifiedAddress: 'addr', mainnet: true },
            polkadot: {
              publicKey: 'pk',
              ss58Address: 'ss58',
              scheme: 'sr25519',
              chain: 'polkadot',
            },
          },
        },
      ],
    });

    const vaults = await v4ExtStorage.get('vaults');
    expect(vaults).toHaveLength(1);
    expect(vaults?.[0]?.id).toBe('vault-1');

    const zignerWallets = await v4ExtStorage.get('zignerWallets');
    expect(zignerWallets?.[0]?.networks.zcash).toEqual({
      orchardFvk: 'fvk',
      unifiedAddress: 'addr',
      mainnet: true,
    });
    expect(zignerWallets?.[0]?.networks).not.toHaveProperty('polkadot');
  });

  test('enabledNetworks and activeNetwork drop polkadot/kusama without touching other networks', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 3,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      enabledNetworks: ['zcash', 'polkadot', 'kusama', 'noble'],
      activeNetwork: 'polkadot',
    });

    const enabledNetworks = await v4ExtStorage.get('enabledNetworks');
    expect(enabledNetworks).toEqual(['zcash', 'noble']);

    const activeNetwork = await v4ExtStorage.get('activeNetwork');
    expect(activeNetwork).toBeUndefined();
  });

  test('a non-polkadot active network is left untouched', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 3,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      enabledNetworks: ['zcash'],
      activeNetwork: 'zcash',
    });

    const activeNetwork = await v4ExtStorage.get('activeNetwork');
    expect(activeNetwork).toBe('zcash');
  });

  test('a polkadot-only vault is never deleted', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 3,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      vaults: [
        {
          id: 'vault-polkadot-only',
          type: 'zigner-zafu',
          name: 'zigner',
          createdAt: 1,
          encryptedData: 'enc',
          salt: '',
          insensitive: { supportedNetworks: ['polkadot'] },
        },
      ],
    });

    const vaults = await v4ExtStorage.get('vaults');
    expect(vaults).toHaveLength(1);
    expect(vaults?.[0]?.id).toBe('vault-polkadot-only');
  });

  test('contacts and recentAddresses drop polkadot/kusama entries only', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 3,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      contacts: [
        {
          id: 'c1',
          name: 'alice',
          createdAt: 1,
          addresses: [
            { id: 'a1', network: 'zcash', address: 'zaddr' },
            { id: 'a2', network: 'polkadot', address: 'ss58' },
            { id: 'a3', network: 'kusama', address: 'ss58k' },
          ],
        },
      ],
      recentAddresses: [
        { address: 'zaddr', network: 'zcash', useCount: 1, lastUsedAt: 1, firstUsedAt: 1 },
        { address: 'ss58', network: 'polkadot', useCount: 1, lastUsedAt: 1, firstUsedAt: 1 },
      ],
    });

    const contacts = await v4ExtStorage.get('contacts');
    expect(contacts?.[0]?.addresses).toEqual([{ id: 'a1', network: 'zcash', address: 'zaddr' }]);

    const recentAddresses = await v4ExtStorage.get('recentAddresses');
    expect(recentAddresses).toHaveLength(1);
    expect(recentAddresses?.[0]?.network).toBe('zcash');
  });

  test('enabledParachains, customChainspecs, polkadotVaultSettings and polkadotZignerAccounts are dropped', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 3,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      enabledParachains: { polkadot: ['hydration'] },
      customChainspecs: [
        {
          id: 'hydration',
          name: 'Hydration',
          relay: 'polkadot',
          chainspec: '{}',
          addedAt: 1,
        },
      ],
      polkadotVaultSettings: { legacyMode: true },
      polkadotZignerAccounts: [
        { id: 'p1', label: 'polkadot', ss58Address: 'ss58', genesisHash: '0x0', importedAt: 1 },
      ],
      activePolkadotZignerIndex: 0,
    } as never);

    expect(await v4ExtStorage.get('enabledParachains' as never)).toBeUndefined();
    expect(await v4ExtStorage.get('customChainspecs' as never)).toBeUndefined();
    expect(await v4ExtStorage.get('polkadotVaultSettings' as never)).toBeUndefined();
    expect(await v4ExtStorage.get('polkadotZignerAccounts' as never)).toBeUndefined();
    expect(await v4ExtStorage.get('activePolkadotZignerIndex' as never)).toBeUndefined();
  });

  test('running the migration twice is a no-op', async () => {
    await storageArea.set({
      [VERSION_FIELD]: 3,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      enabledNetworks: ['zcash', 'polkadot'],
    });

    const first = await v4ExtStorage.get('enabledNetworks');
    expect(first).toEqual(['zcash']);

    // a second storage instance over the already-migrated data must not change it further
    const again = new ExtensionStorage<Storage_V4.LOCAL, Storage_V4.VERSION>(
      storageArea,
      defaultData,
      4,
      { 0: local_v0_v1, 1: local_v1_v2, 2: local_v2_v3, 3: local_v3_v4 },
    );
    const second = await again.get('enabledNetworks');
    expect(second).toEqual(['zcash']);
  });

  test('sealed (encrypted) lists pass through untouched instead of failing the migration', async () => {
    const sealed = { encrypted: { nonce: 'bm9uY2U=', cipherText: 'c2VhbGVk' } };
    await storageArea.set({
      [VERSION_FIELD]: 3,
      penumbraWallets: [],
      knownSites: [],
      numeraires: [],
      enabledNetworks: ['zcash', 'polkadot'],
      contacts: sealed,
      recentAddresses: sealed,
      zignerWallets: sealed,
      networkEndpoints: sealed,
    });

    await expect(v4ExtStorage.get('recentAddresses')).resolves.toEqual(sealed);
    expect(await v4ExtStorage.get('contacts')).toEqual(sealed);
    expect(await v4ExtStorage.get('zignerWallets')).toEqual(sealed);
    expect(await v4ExtStorage.get('enabledNetworks')).toEqual(['zcash']);
  });
});
