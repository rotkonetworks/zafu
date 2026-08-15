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
  /**
   * If set, this network is a SUBNETWORK of `parent` rather than a top-level
   * network - it appears as a sub-selection inside the parent (e.g. the cosmos
   * IBC destinations under Penumbra), not in the top-level network picker. Used
   * for the unshield -> transparent-chain -> exchange flow.
   */
  parent?: NetworkType;
  features: {
    stake: boolean;
    swap: boolean;
    /** governance voting */
    vote: boolean;
    /** encrypted inbox for memo-capable chains */
    inbox: boolean;
    /** FROST threshold multisig (shielded chains) */
    multisig: boolean;
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
    features: { stake: false, swap: false, vote: true, inbox: true, multisig: true },
  },
  penumbra: {
    name: 'Penumbra',
    color: 'bg-purple-500',
    focusColor: 'focus:border-penumbra-purple',
    transparent: false,
    launched: true,
    // multisig: FROST threshold wallets are not implemented for Penumbra yet.
    features: { stake: true, swap: false, vote: true, inbox: true, multisig: false },
  },
  polkadot: {
    name: 'Polkadot',
    color: 'bg-gray-500',
    focusColor: 'focus:border-pink-500',
    transparent: true,
    launched: false,
    features: { stake: true, swap: false, vote: false, inbox: false, multisig: false },
  },
  kusama: {
    name: 'Kusama',
    color: 'bg-gray-500',
    focusColor: 'focus:border-red-500',
    transparent: true,
    launched: false,
    features: { stake: true, swap: false, vote: false, inbox: false, multisig: false },
  },
  noble: {
    name: 'Noble',
    color: 'bg-blue-400',
    focusColor: 'focus:border-blue-400',
    transparent: true,
    // Penumbra subnetwork: the USDC/CCTP gateway, default IBC destination for
    // unshielding and the off-ramp path to exchanges (Coinbase etc.).
    launched: true,
    parent: 'penumbra',
    features: { stake: false, swap: false, vote: false, inbox: false, multisig: false },
  },
  cosmoshub: {
    name: 'Cosmos Hub',
    color: 'bg-indigo-500',
    focusColor: 'focus:border-indigo-500',
    transparent: true,
    // Penumbra subnetwork; not enabled yet (no live IBC channel in veil config).
    launched: false,
    parent: 'penumbra',
    features: { stake: true, swap: false, vote: false, inbox: false, multisig: false },
  },
  ethereum: {
    name: 'Ethereum',
    color: 'bg-blue-500',
    focusColor: 'focus:border-blue-500',
    transparent: true,
    launched: false,
    features: { stake: false, swap: true, vote: false, inbox: false, multisig: false },
  },
  bitcoin: {
    name: 'Bitcoin',
    color: 'bg-orange-400',
    focusColor: 'focus:border-orange-400',
    transparent: true,
    launched: false,
    features: { stake: false, swap: false, vote: false, inbox: false, multisig: false },
  },
};

/** derive display info - computed once, no runtime overhead */
export const getNetwork = (network: NetworkType): NetworkConfig =>
  NETWORKS[network] ?? {
    name: network,
    color: 'bg-gray-500',
    focusColor: 'focus:border-primary/50',
    transparent: true,
    launched: false,
    features: { stake: false, swap: false, vote: false, inbox: false, multisig: false },
  };

/** check feature support */
export const hasFeature = (
  network: NetworkType,
  feature: keyof NetworkConfig['features'],
): boolean => getNetwork(network).features[feature];

/** launched top-level networks (no parent) - the main network picker */
export const getTopLevelNetworks = (): NetworkType[] =>
  (Object.keys(NETWORKS) as NetworkType[]).filter(n => NETWORKS[n].launched && !NETWORKS[n].parent);

/** launched subnetworks (IBC destinations) of a parent network */
export const getSubnetworks = (parent: NetworkType): NetworkType[] =>
  (Object.keys(NETWORKS) as NetworkType[]).filter(
    n => NETWORKS[n].launched && NETWORKS[n].parent === parent,
  );

/** the root (top-level) network for any network: its parent, or itself */
export const getRootNetwork = (network: NetworkType): NetworkType =>
  getNetwork(network).parent ?? network;

/** true if `network` belongs to `root`'s group (is `root` or a subnetwork of it) */
export const isInNetworkGroup = (network: NetworkType, root: NetworkType): boolean =>
  getRootNetwork(network) === root;

/** check if network is available for selection */
export const isLaunched = (network: NetworkType): boolean => getNetwork(network).launched;

/** only launched networks — used for network selector UI */
export const LAUNCHED_NETWORKS = (Object.keys(NETWORKS) as NetworkType[]).filter(
  id => NETWORKS[id].launched,
);
