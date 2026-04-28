/**
 * single source of truth for network configuration
 * solidjs-style: data as plain objects, derived where needed
 */

import type { NetworkType } from '../state/keyring';

/** orchard pool activation height — no zcash wallet should scan before this */
export const ZCASH_ORCHARD_ACTIVATION = 1_687_104;

export interface NetworkConfig {
  name: string;
  color: string;
  /** tailwind class for focus border on inputs */
  focusColor: string;
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
  zcash: {
    name: 'Zcash',
    color: 'bg-yellow-500',
    focusColor: 'focus:border-zigner-gold',
    transparent: false,
    launched: true,
    features: { stake: false, swap: false, vote: false, inbox: true },
  },
  penumbra: {
    name: 'Penumbra',
    color: 'bg-purple-500',
    focusColor: 'focus:border-penumbra-purple',
    transparent: false,
    launched: true,
    features: { stake: true, swap: false, vote: true, inbox: true },
  },
  polkadot: {
    name: 'Polkadot',
    color: 'bg-gray-500',
    focusColor: 'focus:border-pink-500',
    transparent: true,
    launched: false,
    features: { stake: true, swap: false, vote: false, inbox: false },
  },
  kusama: {
    name: 'Kusama',
    color: 'bg-gray-500',
    focusColor: 'focus:border-red-500',
    transparent: true,
    launched: false,
    features: { stake: true, swap: false, vote: false, inbox: false },
  },
  noble: {
    name: 'Noble',
    color: 'bg-blue-400',
    focusColor: 'focus:border-blue-400',
    transparent: true,
    launched: false,
    features: { stake: false, swap: false, vote: false, inbox: false },
  },
  cosmoshub: {
    name: 'Cosmos Hub',
    color: 'bg-indigo-500',
    focusColor: 'focus:border-indigo-500',
    transparent: true,
    launched: false,
    features: { stake: true, swap: false, vote: false, inbox: false },
  },
  ethereum: {
    name: 'Ethereum',
    color: 'bg-blue-500',
    focusColor: 'focus:border-blue-500',
    transparent: true,
    launched: false,
    features: { stake: false, swap: true, vote: false, inbox: false },
  },
  bitcoin: {
    name: 'Bitcoin',
    color: 'bg-orange-400',
    focusColor: 'focus:border-orange-400',
    transparent: true,
    launched: false,
    features: { stake: false, swap: false, vote: false, inbox: false },
  },
};

/** derive display info - computed once, no runtime overhead */
export const getNetwork = (network: NetworkType): NetworkConfig =>
  NETWORKS[network] ?? { name: network, color: 'bg-gray-500', focusColor: 'focus:border-primary/50', transparent: true, launched: false, features: { stake: false, swap: false, vote: false, inbox: false } };

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
