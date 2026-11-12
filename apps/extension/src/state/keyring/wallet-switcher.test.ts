import { describe, expect, test } from 'vitest';
import type { AllSlices } from '..';
import { selectKeyInfosForActiveNetwork, selectSwitcherKeyInfos } from '.';
import { keyInfoNetworks, networkForWallet } from './vault-ops';
import type { KeyInfo, NetworkType } from './types';

const wallet = (id: string, supportedNetworks?: string[], hidden = false): KeyInfo => ({
  id,
  name: id,
  type: 'zigner-zafu',
  isSelected: false,
  createdAt: 0,
  insensitive: {
    ...(supportedNetworks ? { supportedNetworks } : {}),
    ...(hidden ? { hidden: true } : {}),
  },
});

// one zcash-only zigner and one penumbra-only zigner, as imported one after the other
const zcashCold = wallet('zcash-cold', ['zcash']);
const penumbraCold = wallet('penumbra-cold', ['penumbra']);
const table = wallet('table', ['zcash'], true);

const state = (activeNetwork: NetworkType) =>
  ({
    keyRing: { keyInfos: [zcashCold, penumbraCold, table], activeNetwork },
  }) as unknown as AllSlices;

describe('the accounts sheet lists every wallet', () => {
  test('both zigner wallets on either network, hidden ones aside', () => {
    for (const n of ['zcash', 'penumbra'] as const) {
      expect(selectSwitcherKeyInfos(state(n)).map(k => k.id)).toEqual([
        'zcash-cold',
        'penumbra-cold',
      ]);
    }
    // the per-network list it used to show had only one of them
    expect(selectKeyInfosForActiveNetwork(state('zcash')).map(k => k.id)).toEqual(['zcash-cold']);
  });

  test('a wallet says which networks it is limited to', () => {
    expect(keyInfoNetworks(penumbraCold)).toEqual(['penumbra']);
    expect(keyInfoNetworks(wallet('seed'))).toBeUndefined();
  });
});

describe('networkForWallet', () => {
  test('stays on the active network when the wallet serves it', () => {
    expect(networkForWallet(zcashCold, 'zcash', ['zcash', 'penumbra'])).toBe('zcash');
    expect(networkForWallet(wallet('seed'), 'penumbra', ['zcash', 'penumbra'])).toBe('penumbra');
  });

  test('moves to a network the wallet serves, one that is on first', () => {
    expect(networkForWallet(penumbraCold, 'zcash', ['zcash', 'penumbra'])).toBe('penumbra');
    const both = wallet('both', ['zcash', 'penumbra']);
    expect(networkForWallet(both, 'osmosis', ['penumbra'])).toBe('penumbra');
  });

  test('names a network that is off when the wallet serves no other', () => {
    expect(networkForWallet(penumbraCold, 'zcash', ['zcash'])).toBe('penumbra');
  });
});
