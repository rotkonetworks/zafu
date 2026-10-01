import { describe, expect, it } from 'vitest';
import { NETWORKS } from '../../../config/networks';
import { chainByChainId } from '@repo/wallet/networks/cosmos/chains';
import type { NetworkType } from '../../../state/keyring';
import { resolveNetworkCosmosChain } from './chain-identity';

const launchedIbcSubnetworks = (Object.keys(NETWORKS) as NetworkType[]).filter(
  n => NETWORKS[n].launched && NETWORKS[n].ibcChainId,
);

describe('resolveNetworkCosmosChain', () => {
  it('has live IBC subnetworks to classify', () => {
    // if this ever empties the suite below passes vacuously
    expect(launchedIbcSubnetworks.length).toBeGreaterThan(0);
  });

  it.each(launchedIbcSubnetworks)('%s resolves to its canonical chain id', network => {
    const ibcChainId = NETWORKS[network].ibcChainId!;
    expect(resolveNetworkCosmosChain(network)).toBe(chainByChainId(ibcChainId)?.id);
  });

  it('classifies the chains the noble-only allow-list used to drop', () => {
    // the symptom: cosmoshub/osmosis sends fell through to the generic form
    expect(resolveNetworkCosmosChain('noble')).toBe('noble');
    expect(resolveNetworkCosmosChain('cosmoshub')).toBe('cosmoshub');
    expect(resolveNetworkCosmosChain('osmosis')).toBe('osmosis');
    expect(resolveNetworkCosmosChain('injective')).toBe('injective');
  });

  it('returns none for a network outside the registry instead of casting', () => {
    expect(resolveNetworkCosmosChain('dogecoin' as NetworkType)).toBeUndefined();
    expect(resolveNetworkCosmosChain('celestia' as NetworkType)).toBeUndefined();
  });

  it('returns none for an unlaunched or non-IBC network', () => {
    expect(resolveNetworkCosmosChain('ethereum')).toBeUndefined();
    expect(resolveNetworkCosmosChain('penumbra')).toBeUndefined();
    expect(resolveNetworkCosmosChain('zcash')).toBeUndefined();
  });
});
