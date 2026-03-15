/**
 * single source of truth for network configuration
 * solidjs-style: data as plain objects, derived where needed
 */

import type { NetworkType } from '../state/keyring';

export interface NetworkConfig {
  name: string;
  color: string;
  /** transparent chains have fully public ledgers — all balances and transactions visible */
  transparent: boolean;
  /** whether this network is available for selection in the UI */
  launched: boolean;
  features: {
    stake: boolean;
    swap: boolean;
    /** governance voting */
    vote: boolean;
    /** encrypted inbox for memo-capable chains */
    inbox: boolean;
  };
}

/** all network configs - the single source of truth */
export const NETWORKS: Record<NetworkType, NetworkConfig> = {
  penumbra: {
    name: 'Penumbra',
    color: 'bg-purple-500',
    transparent: false,
    launched: true,
    features: { stake: true, swap: false, vote: true, inbox: true },
  },
  zcash: {
    name: 'Zcash',
    color: 'bg-yellow-500',
    transparent: false,
    launched: true,
    features: { stake: false, swap: false, vote: false, inbox: true },
  },
  polkadot: {
    name: 'Polkadot',
    color: 'bg-gray-500',
    transparent: true,
    launched: false,
    features: { stake: true, swap: false, vote: false, inbox: false },
  },
  kusama: {
    name: 'Kusama',
    color: 'bg-gray-500',
    transparent: true,
    launched: false,
    features: { stake: true, swap: false, vote: false, inbox: false },
  },
  osmosis: {
    name: 'Osmosis',
    color: 'bg-purple-400',
    transparent: true,
    launched: false,
    features: { stake: true, swap: true, vote: false, inbox: false },
  },
  noble: {
    name: 'Noble',
    color: 'bg-blue-400',
    transparent: true,
    launched: false,
    features: { stake: false, swap: false, vote: false, inbox: false },
  },
  nomic: {
    name: 'Nomic',
    color: 'bg-orange-500',
    transparent: true,
    launched: false,
    features: { stake: false, swap: false, vote: false, inbox: false },
  },
  celestia: {
    name: 'Celestia',
    color: 'bg-purple-600',
    transparent: true,
    launched: false,
    features: { stake: true, swap: false, vote: false, inbox: false },
  },
  ethereum: {
    name: 'Ethereum',
    color: 'bg-blue-500',
    transparent: true,
    launched: false,
    features: { stake: false, swap: true, vote: false, inbox: false },
  },
  bitcoin: {
    name: 'Bitcoin',
    color: 'bg-orange-400',
    transparent: true,
    launched: false,
    features: { stake: false, swap: false, vote: false, inbox: false },
  },
};

/** derive display info - computed once, no runtime overhead */
export const getNetwork = (network: NetworkType): NetworkConfig =>
  NETWORKS[network] ?? { name: network, color: 'bg-gray-500', transparent: true, launched: false, features: { stake: false, swap: false, vote: false, inbox: false } };

/** check feature support */
export const hasFeature = (network: NetworkType, feature: keyof NetworkConfig['features']): boolean =>
  getNetwork(network).features[feature];

/** check if network is available for selection */
export const isLaunched = (network: NetworkType): boolean =>
  getNetwork(network).launched;

/** only launched networks — used for network selector UI */
export const LAUNCHED_NETWORKS = (Object.keys(NETWORKS) as NetworkType[]).filter(
  id => NETWORKS[id].launched
);
