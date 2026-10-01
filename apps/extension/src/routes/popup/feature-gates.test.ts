/**
 * Network capability gates.
 *
 * This pins `NETWORKS[*].features` to the behaviour the pre-migration literal
 * checks produced. The expectations are transcribed from the ORIGINAL
 * `=== 'zcash'` / `=== 'penumbra'` / `isIbcNetwork(n) || n === ...` checks - not
 * derived from the corrected table - so a wrong feature value fails here rather
 * than silently changing which tabs, routes and components render.
 */

import { describe, expect, it } from 'vitest';
import { NETWORKS, hasFeature } from '../../config/networks';
import { type NetworkType } from '../../state/keyring/network-types';

const NETWORK_IDS = Object.keys(NETWORKS) as NetworkType[];

type FeatureKey = keyof (typeof NETWORKS)[NetworkType]['features'];

const ALL_FEATURES: FeatureKey[] = [
  'stake',
  'swap',
  'vote',
  'inbox',
  'multisig',
  'cosmos',
  'zcash',
];

/**
 * The exact enabled-feature set each network had before this migration, read off
 * the original literal sites:
 * - multisig  home <MultisigOverview/> + multisig route gate: zcash
 * - stake     stake page query/render gate: penumbra
 * - vote      vote page availability: ZcashVotePage (zcash) || penumbra gov
 * - swap      swap page: zcash crosschain || penumbra dex
 * - inbox     inbox route handled for the memo-capable chains: zcash, penumbra
 * - cosmos    privacy rows `isIbcNetwork(n) || n === 'penumbra'`
 * - zcash     privacy rows `n === 'zcash'`
 */
const EXPECTED_SETS: Record<NetworkType, FeatureKey[]> = {
  zcash: ['swap', 'vote', 'inbox', 'multisig', 'zcash'],
  penumbra: ['stake', 'swap', 'vote', 'inbox', 'cosmos'],
  noble: ['cosmos'],
  cosmoshub: ['cosmos'],
  osmosis: ['cosmos'],
  injective: ['cosmos'],
  ethereum: [],
  bitcoin: [],
};

describe('NETWORKS features match the original literal gates', () => {
  it('covers every network in NETWORKS', () => {
    expect(Object.keys(EXPECTED_SETS).sort()).toEqual([...NETWORK_IDS].sort());
  });

  it.each(NETWORK_IDS)('%s has the literal-derived feature set', network => {
    const enabled = ALL_FEATURES.filter(feature => hasFeature(network, feature));
    expect(enabled).toEqual(EXPECTED_SETS[network]);
  });

  it.each(NETWORK_IDS)('%s: each flag equals its original literal predicate', network => {
    // transcribed literal checks from the migrated sites
    expect(hasFeature(network, 'multisig')).toBe(network === 'zcash');
    expect(hasFeature(network, 'stake')).toBe(network === 'penumbra');
    expect(hasFeature(network, 'vote')).toBe(network === 'zcash' || network === 'penumbra');
    expect(hasFeature(network, 'swap')).toBe(network === 'zcash' || network === 'penumbra');
    expect(hasFeature(network, 'inbox')).toBe(network === 'zcash' || network === 'penumbra');
    expect(hasFeature(network, 'cosmos')).toBe(
      network === 'noble' ||
        network === 'cosmoshub' ||
        network === 'osmosis' ||
        network === 'injective' ||
        network === 'penumbra',
    );
    expect(hasFeature(network, 'zcash')).toBe(network === 'zcash');
  });
});
