import { describe, expect, it, vi } from 'vitest';
// these cases describe the beta build, where hyperliquid is offered (prod: hyperliquid-prod.test.ts)
vi.mock('./feature-flags', async orig => ({ ...(await orig<object>()), IS_BETA_BUILD: true }));

import {
  getNetwork,
  getSubnetworks,
  getTopLevelNetworks,
  hasFeature,
  testnetOf,
  zcashNetworkOf,
} from './networks';
import { selectNetworkShown } from '../state/wallets';
import { getNetworkConfig, getNetworkEncryption } from '../state/keyring/network-types';
import { selectZcashBackend, selectZcashEndpoint, zcashEndpointOf } from '../state/networks';
import type { AllSlices } from '../state';

const hot = { id: 'v', type: 'mnemonic', insensitive: {} };
const hotState = (enabledNetworks: string[], endpoint = '') =>
  ({
    keyRing: { keyInfos: [hot], selectedKeyInfo: hot, activeNetwork: 'zcash', enabledNetworks },
    wallets: { zcashWallets: [], activeZcashIndex: 0 },
    networks: { networks: { zcash: { endpoint, backend: 'lightwalletd' } } },
  }) as unknown as AllSlices;

describe('zcash testnet', () => {
  it('is a switch under zcash, never a network of its own in the picker', () => {
    expect(getTopLevelNetworks(true, [])).not.toContain('zcash-testnet');
    expect(getSubnetworks('zcash')).toEqual([]);
    expect(testnetOf('zcash')).toBe('zcash-testnet');
    expect(getNetwork('zcash-testnet').parent).toBe('zcash');
  });

  it('reads TAZ, keeps zcash keys, and has nothing to swap or vote', () => {
    expect(getNetworkConfig('zcash-testnet')).toMatchObject({ symbol: 'TAZ', decimals: 8 });
    expect(getNetworkEncryption('zcash-testnet')).toBe('zcash');
    for (const f of ['swap', 'vote', 'stake'] as const) {
      expect(hasFeature('zcash-testnet', f)).toBe(false);
    }
    expect(hasFeature('zcash-testnet', 'multisig')).toBe(true);
    expect(zcashNetworkOf(true)).toBe('zcash');
    expect(zcashNetworkOf(false)).toBe('zcash-testnet');
  });

  it("speaks to the testnet node only while it is on, and mainnet's stays the person's choice", () => {
    expect(selectZcashEndpoint(hotState(['zcash']))).toBe('https://zcash.rotko.net');
    expect(selectZcashEndpoint(hotState(['zcash'], 'https://mine.example'))).toBe(
      'https://mine.example',
    );
    const on = hotState(['zcash', 'zcash-testnet'], 'https://mine.example');
    expect(selectZcashEndpoint(on)).toBe('https://tzcash.rotko.net');
    expect(selectZcashBackend(on)).toBe('zidecar');
    expect(selectZcashBackend(hotState(['zcash']))).toBe('lightwalletd');
    // a mainnet shared wallet keeps its node while testnet is on
    expect(zcashEndpointOf(on, true)).toBe('https://mine.example');
  });
});

describe('penumbra testnet', () => {
  const penumbraState = (enabledNetworks: string[]) =>
    ({
      ...hotState(enabledNetworks),
      keyRing: {
        keyInfos: [hot],
        selectedKeyInfo: hot,
        activeNetwork: 'penumbra',
        enabledNetworks,
      },
    }) as unknown as AllSlices;

  it('is a switch under penumbra, apart from its ibc chains', () => {
    expect(getTopLevelNetworks(true, [])).not.toContain('penumbra-testnet');
    expect(testnetOf('penumbra')).toBe('penumbra-testnet');
    expect(getSubnetworks('penumbra')).not.toContain('penumbra-testnet');
    expect(getSubnetworks('penumbra')).toContain('noble');
    expect(getNetworkEncryption('penumbra-testnet')).toBe('penumbra');
  });

  it('has no prices, swaps, votes or ibc', () => {
    for (const f of ['swap', 'vote', 'stake', 'cosmos'] as const) {
      expect(hasFeature('penumbra-testnet', f)).toBe(false);
    }
    expect(hasFeature('penumbra', 'cosmos')).toBe(true);
  });

  it('is the network shown while its switch is on, whatever the wallet', () => {
    expect(selectNetworkShown(penumbraState(['penumbra']))).toBe('penumbra');
    expect(selectNetworkShown(penumbraState(['penumbra', 'penumbra-testnet']))).toBe(
      'penumbra-testnet',
    );
    // zcash's switch leaves penumbra on mainnet, and the other way round
    expect(selectNetworkShown(penumbraState(['penumbra', 'zcash-testnet']))).toBe('penumbra');
    expect(selectNetworkShown(hotState(['zcash', 'penumbra-testnet']))).toBe('zcash');
    expect(selectNetworkShown(hotState(['zcash', 'zcash-testnet']))).toBe('zcash-testnet');
  });
});

describe('hyperliquid', () => {
  it('is offered only while beta features are on', () => {
    expect(getTopLevelNetworks(true, [])).toContain('hyperliquid');
    expect(getTopLevelNetworks(false, ['zcash'])).toEqual(['zcash', 'penumbra']);
  });

  it('stays listed once on, so it can be turned off with beta features off', () => {
    expect(getTopLevelNetworks(false, ['hyperliquid'])).toContain('hyperliquid');
  });

  it('is the evm key, with nothing to trade', () => {
    expect(getNetworkEncryption('hyperliquid')).toBe('ethereum');
    expect(getNetworkConfig('hyperliquid')).toMatchObject({ symbol: 'USDC', decimals: 6 });
    for (const f of ['swap', 'vote', 'stake'] as const) {
      expect(hasFeature('hyperliquid', f)).toBe(false);
    }
  });
});
