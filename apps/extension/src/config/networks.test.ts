import { describe, expect, it } from 'vitest';
import {
  getNetwork,
  getSubnetworks,
  getTopLevelNetworks,
  hasFeature,
  zcashNetworkOf,
} from './networks';
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
    expect(getTopLevelNetworks()).not.toContain('zcash-testnet');
    expect(getSubnetworks('zcash')).toEqual(['zcash-testnet']);
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
