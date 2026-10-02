import { describe, expect, it } from 'vitest';
import type { Chain } from '@penumbrafi/registry';
import { COSMOS_CHAINS } from './chains';
import { chainsFromRegistry } from './registry-chains';

const conn = (channelId: string, status: Chain['status'], chainName = 'axelar'): Chain => ({
  addressPrefix: 'axelar',
  chainId: 'axelar-dojo-1',
  channelId,
  counterpartyChannelId: `counter-${channelId}`,
  displayName: status === 'expired' ? 'Axelar (legacy)' : 'Axelar',
  images: [],
  status,
  transparent: {
    chainName,
    bech32Prefix: 'axelar',
    coinType: 118,
    denom: 'uaxl',
    symbol: 'AXL',
    decimals: 6,
    gasPrice: '0.007uaxl',
    rpc: ['https://axelar-rpc.polkachu.com'],
    rest: ['https://rest.cosmos.directory/axelar'],
  },
});

describe('chainsFromRegistry', () => {
  it('pins the active connection over an expired one', () => {
    const { axelar } = chainsFromRegistry([
      conn('channel-7', 'expired'),
      conn('channel-24', 'active'),
    ]);
    expect(axelar).toMatchObject({
      name: 'Axelar',
      penumbraSourceChannel: 'channel-24',
      penumbraChannel: 'counter-channel-24',
      gasPrice: '0.007uaxl',
    });
  });

  it('prefers the lowest active channel, else the newest expired one', () => {
    expect(
      chainsFromRegistry([conn('channel-20', 'active'), conn('channel-19', 'active')])['axelar']
        ?.penumbraSourceChannel,
    ).toBe('channel-19');
    expect(
      chainsFromRegistry([conn('channel-3', 'expired'), conn('channel-9', 'expired')])['axelar']
        ?.penumbraSourceChannel,
    ).toBe('channel-9');
  });

  it('skips a connection the registry gives no transparent chain', () => {
    const { transparent: _, ...bare } = conn('channel-18', 'active', 'injective');
    expect(chainsFromRegistry([bare])).toEqual({});
  });
});

/**
 * Pinned against the bundled registry: a registry release that changes a
 * chain's address format, key path, fee token or channel shows up here as a
 * test diff, never silently.
 */
describe('COSMOS_CHAINS from the bundled registry and presets', () => {
  const pinned = Object.fromEntries(
    Object.values(COSMOS_CHAINS).map(c => [
      c.id,
      [c.chainId, c.bech32Prefix, c.coinType ?? 118, c.denom, c.penumbraSourceChannel],
    ]),
  );

  it('has exactly these chains with these parameters', () => {
    expect(pinned).toEqual({
      axelar: ['axelar-dojo-1', 'axelar', 118, 'uaxl', 'channel-24'],
      celestia: ['celestia', 'celestia', 118, 'utia', 'channel-23'],
      cosmoshub: ['cosmoshub-4', 'cosmos', 118, 'uatom', 'channel-22'],
      dydx: ['dydx-mainnet-1', 'dydx', 118, 'adydx', 'channel-16'],
      injective: [
        'injective-1',
        'inj',
        60,
        'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a',
        'channel-18',
      ],
      kava: ['kava_2222-10', 'kava', 459, 'ukava', 'channel-21'],
      neutron: ['neutron-1', 'neutron', 118, 'untrn', 'channel-9'],
      noble: ['noble-1', 'noble', 118, 'uusdc', 'channel-2'],
      osmosis: ['osmosis-1', 'osmo', 118, 'uosmo', 'channel-20'],
    });
  });

  it('talks only to trusted node operators', () => {
    const trusted =
      /(^|\.)(polkachu\.com|publicnode\.com|cosmos\.directory|keplr\.app|injective\.network)$/;
    for (const c of Object.values(COSMOS_CHAINS)) {
      for (const url of [c.rpcEndpoint, c.restEndpoint, ...(c.rpcEndpoints ?? [])]) {
        expect(new URL(url).hostname, `${c.id} ${url}`).toMatch(trusted);
      }
    }
  });
});
