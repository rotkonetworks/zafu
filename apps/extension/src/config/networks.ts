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
  /**
   * For a cosmos subnetwork: its IBC chain id (e.g. 'noble-1'). Only set on
   * subnetworks that currently have a LIVE channel + client with the parent -
   * IBC deposit/withdraw is gated to these. Channels close on network upgrades
   * and must be reopened; set/unset this (with `launched`) as they come back.
   */
  ibcChainId?: string;
  /**
   * Average block interval of this chain, in milliseconds. Only meaningful
   * alongside `ibcChainId`: an ICS-20 packet carries a timeout expressed as a
   * block HEIGHT on the destination chain, so turning "keep this packet live
   * for roughly N hours" into a height offset needs the destination's own block
   * rate. Chains differ by an order of magnitude (Injective ~0.7s vs Noble
   * ~5.5s), so a single constant silently gives Injective a 12-minute window.
   */
  ibcBlockTimeMs?: number;
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
    color: 'bg-teal-400',
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
    ibcChainId: 'noble-1',
    // Noble targets ~5s; observed intervals sit just above it.
    ibcBlockTimeMs: 5_500,
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
  osmosis: {
    name: 'Osmosis',
    color: 'bg-purple-400',
    focusColor: 'focus:border-purple-400',
    transparent: true,
    // Penumbra subnetwork: standard cosmos chain (secp256k1, coin type 118).
    // launched:false until the osmosis<->penumbra channel client is confirmed
    // Active (registry has channel-4/channel-17; verify before flipping).
    launched: false,
    parent: 'penumbra',
    ibcChainId: 'osmosis-1',
    ibcBlockTimeMs: 2_500,
    features: { stake: false, swap: false, vote: false, inbox: false, multisig: false },
  },
  injective: {
    name: 'Injective',
    color: 'bg-cyan-400',
    focusColor: 'focus:border-cyan-400',
    transparent: true,
    // Penumbra subnetwork: the native-USDC (USDC.inj) receive+shield ramp that
    // replaces the sunsetting Noble path. Ethermint (eth_secp256k1/coin-type-60)
    // so it derives+signs via packages/wallet/src/networks/injective, NOT the
    // shared cosmos secp256k1 path. Signer proven on mainnet (round-trip tx
    // 5699D4FC..., code 0) and the live channel-494/18 is wired. LAUNCHED: we run
    // the inj<->penumbra relayer ourselves (hermes/ops/injective, gatus at
    // status.penumbra.fi) and the client 07-tendermint-353 is Active. Injective
    // is now the shielding ramp; Noble is off-ramp (withdraw) only.
    launched: true,
    parent: 'penumbra',
    ibcChainId: 'injective-1',
    // Injective runs sub-second blocks (~0.65-0.8s).
    ibcBlockTimeMs: 700,
    features: { stake: false, swap: false, vote: false, inbox: false, multisig: false },
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

/**
 * IBC chain ids reachable from `parent` right now: launched subnetworks that
 * carry an `ibcChainId` (a live channel + client). Channels close on network
 * upgrades and re-open by setting `ibcChainId` + `launched`. Every derive /
 * balance / sign on these chains goes through conduitFor (packages/wallet
 * networks/transparent), which keeps Injective on its coin-type-60 path.
 */
export const getActiveIbcChainIds = (parent: NetworkType): string[] =>
  (Object.keys(NETWORKS) as NetworkType[])
    .filter(n => NETWORKS[n].launched && NETWORKS[n].parent === parent && NETWORKS[n].ibcChainId)
    .map(n => NETWORKS[n].ibcChainId!);

/** As above but returns the network KEYS (e.g. 'noble'), for gating by activeNetwork. */
export const getActiveIbcSubnetworks = (parent: NetworkType): NetworkType[] =>
  (Object.keys(NETWORKS) as NetworkType[]).filter(
    n => NETWORKS[n].launched && NETWORKS[n].parent === parent && NETWORKS[n].ibcChainId,
  );

/**
 * Fallback block interval for an IBC destination we have no measured rate for.
 * ~6s is the classic cosmos-sdk default, and erring slow means erring towards a
 * SMALLER height offset, i.e. an earlier (safe) refund rather than a packet that
 * outlives its usefulness.
 */
export const DEFAULT_IBC_BLOCK_TIME_MS = 6_000;

/** average block interval (ms) for an IBC chain id, e.g. 'injective-1' -> 700 */
export const getIbcBlockTimeMs = (chainId: string): number => {
  const network = (Object.keys(NETWORKS) as NetworkType[]).find(
    n => NETWORKS[n].ibcChainId === chainId,
  );
  return (network && NETWORKS[network].ibcBlockTimeMs) || DEFAULT_IBC_BLOCK_TIME_MS;
};

/** true if this cosmos subnetwork currently has a live IBC channel (deposit/send ok) */
export const isActiveIbcChain = (network: NetworkType): boolean =>
  Boolean(NETWORKS[network]?.ibcChainId && NETWORKS[network]?.launched);

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
