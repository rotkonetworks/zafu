import { describe, expect, it } from 'vitest';
import type { Chain } from '@penumbrafi/registry';
import { applyLiveConnections, COSMOS_CHAINS } from '@repo/wallet/networks/cosmos/chains';
import { getActiveIbcSubnetworks, NETWORKS } from '../config/networks';
import { DESTINATIONS, EGRESS_INPUT_KEYS } from '../net/egress-policy';
import { NETWORK_CONFIGS } from '../state/keyring/network-types';

const conn = (chainName: string, chainId: string, channelId: string): Chain => ({
  addressPrefix: chainName,
  chainId,
  channelId,
  counterpartyChannelId: 'channel-1',
  displayName: chainName,
  images: [],
  status: 'active',
  transparent: {
    chainName,
    bech32Prefix: chainName,
    coinType: 118,
    denom: `u${chainName}`,
    symbol: chainName.toUpperCase(),
    decimals: 6,
    gasPrice: `0.01u${chainName}`,
    rpc: [`https://${chainName}-rpc.polkachu.com`],
    rest: [`https://rest.cosmos.directory/${chainName}`],
  },
});

describe('a chain the bundle lacks, after a verified live registry loads', () => {
  it('is a cosmos chain, a launched penumbra subnetwork and a gated egress row', () => {
    expect(COSMOS_CHAINS['stargaze']).toBeUndefined();
    expect(applyLiveConnections([conn('stargaze', 'stargaze-1', 'channel-30')])).toEqual([
      'stargaze',
    ]);

    expect(COSMOS_CHAINS['stargaze']?.penumbraSourceChannel).toBe('channel-30');
    expect(NETWORKS['stargaze']).toMatchObject({ parent: 'penumbra', ibcChainId: 'stargaze-1' });
    expect(NETWORK_CONFIGS['stargaze']?.derivationPath).toBe("m/44'/118'/0'/0/0");
    expect(getActiveIbcSubnetworks('penumbra')).toContain('stargaze');
    expect(DESTINATIONS.find(d => d.id === 'stargaze')?.gate).toEqual({
      kind: 'network',
      networks: ['stargaze'],
    });
    expect(EGRESS_INPUT_KEYS.filter(k => k.includes('stargaze'))).toHaveLength(1);
  });

  it('applying it again adds nothing twice, and presets still win', () => {
    expect(applyLiveConnections([conn('stargaze', 'stargaze-1', 'channel-30')])).toEqual([]);
    expect(DESTINATIONS.filter(d => d.id === 'stargaze')).toHaveLength(1);
    applyLiveConnections([conn('noble', 'noble-1', 'channel-99')]);
    expect(COSMOS_CHAINS['noble']?.penumbraSourceChannel).toBe('channel-2');
  });

  it('the registry update row is opt-in only', () => {
    expect(DESTINATIONS.find(d => d.id === 'penumbra-registry')?.gate).toEqual({
      kind: 'optional',
    });
  });
});
