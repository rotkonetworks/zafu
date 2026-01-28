/**
 * single source of truth for network configuration
 * solidjs-style: data as plain objects, derived where needed
 */

import type { NetworkType } from '../state/keyring';

export interface NetworkConfig {
  name: string;
  color: string;
  features: {
    stake: boolean;
    swap: boolean;
    history: boolean;
    /** encrypted inbox for memo-capable chains */
    inbox: boolean;
  };
}

/** all network configs - the single source of truth */
export const NETWORKS: Record<NetworkType, NetworkConfig> = {
  penumbra: {
    name: 'Penumbra',
    color: 'bg-purple-500',
    features: { stake: true, swap: true, history: true, inbox: true },
  },
  zcash: {
    name: 'Zcash',
    color: 'bg-yellow-500',
    features: { stake: false, swap: false, history: true, inbox: true },
  },
  polkadot: {
    name: 'Polkadot',
    color: 'bg-pink-500',
    features: { stake: true, swap: false, history: true, inbox: false },
  },
  kusama: {
    name: 'Kusama',
    color: 'bg-gray-500',
    features: { stake: true, swap: false, history: true, inbox: false },
  },
  osmosis: {
    name: 'Osmosis',
    color: 'bg-purple-400',
    features: { stake: true, swap: true, history: true, inbox: false },
  },
  noble: {
    name: 'Noble',
    color: 'bg-blue-400',
    features: { stake: false, swap: false, history: true, inbox: false },
  },
  nomic: {
    name: 'Nomic',
    color: 'bg-orange-500',
    features: { stake: false, swap: false, history: true, inbox: false },
  },
  celestia: {
    name: 'Celestia',
    color: 'bg-purple-600',
    features: { stake: true, swap: false, history: true, inbox: false },
  },
  ethereum: {
    name: 'Ethereum',
    color: 'bg-blue-500',
    features: { stake: false, swap: true, history: true, inbox: false },
  },
  bitcoin: {
    name: 'Bitcoin',
    color: 'bg-orange-400',
    features: { stake: false, swap: false, history: true, inbox: false },
  },
};

/** derive display info - computed once, no runtime overhead */
export const getNetwork = (network: NetworkType): NetworkConfig =>
  NETWORKS[network] ?? { name: network, color: 'bg-gray-500', features: { stake: false, swap: false, history: true, inbox: false } };

/** check feature support */
export const hasFeature = (network: NetworkType, feature: keyof NetworkConfig['features']): boolean =>
  getNetwork(network).features[feature];
