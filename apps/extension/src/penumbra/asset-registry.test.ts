import { beforeEach, describe, expect, it } from 'vitest';
import { ChainRegistryClient } from '@penumbrafi/registry';
import { AppParameters } from '@penumbra-zone/protobuf/penumbra/core/app/v1/app_pb';
import { Metadata } from '@penumbra-zone/protobuf/penumbra/core/asset/v1/asset_pb';
import { localExtStorage } from '@repo/storage-chrome/local';
import {
  forgetPenumbraRegistry,
  penumbraChainId,
  refreshPenumbraRegistry,
  registryMetadata,
} from './asset-registry';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;

/** what the view service holds for UM: the same asset id on every chain */
const um = new Metadata({
  penumbraAssetId: new ChainRegistryClient().bundled.globals().stakingAssetId,
  base: 'upenumbra',
  display: 'penumbra',
});

const onChain = async (enabledNetworks: string[], testnet?: string) => {
  await localExtStorage.set('enabledNetworks', enabledNetworks);
  if (testnet) {
    await localExtStorage.set(
      'penumbraTestnetParams',
      new AppParameters({ chainId: testnet }).toJsonString(),
    );
  }
  forgetPenumbraRegistry();
  await refreshPenumbraRegistry();
};

describe('the registry for the chain in use', () => {
  beforeEach(() => localMock.clear());

  it("on mainnet, a registered asset shows the registry's own metadata", async () => {
    await onChain(['penumbra']);
    expect(penumbraChainId()).toBe('penumbra-1');
    expect(registryMetadata(um)?.symbol).toBe('UM');
  });

  it('on an unknown testnet, an asset id mainnet also has shows by its own denom', async () => {
    await onChain(['penumbra', 'penumbra-testnet'], 'penumbra-testnet-brinance-1');
    expect(penumbraChainId()).toBe('penumbra-testnet-brinance-1');
    expect(registryMetadata(um)).toBeUndefined();
  });

  it('a testnet no node has named yet never falls back to mainnet', async () => {
    await onChain(['penumbra', 'penumbra-testnet']);
    expect(penumbraChainId()).toBe('');
    expect(registryMetadata(um)).toBeUndefined();
  });

  it('switching back to mainnet restores it', async () => {
    await onChain(['penumbra', 'penumbra-testnet'], 'penumbra-testnet-brinance-1');
    await onChain(['penumbra']);
    expect(registryMetadata(um)?.symbol).toBe('UM');
  });
});
