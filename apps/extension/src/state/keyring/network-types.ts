/**
 * network type definitions
 *
 * aligned with zigner encryption types - same key can sign for any
 * network with matching encryption algorithm
 *
 * encryption types (matching zigner's Encryption enum):
 * - sr25519/ed25519/ecdsa: substrate chains (polkadot, kusama, all parachains)
 * - penumbra: shielded dex
 * - zcash: ZIP-32 derivation for shielded txs
 * - cosmos: BIP44 secp256k1 (osmosis, noble, nomic, celestia)
 * - bitcoin: BIP-84 native segwit
 * - ethereum: standard secp256k1
 *
 * network categories:
 *
 * 1. privacy networks - need local sync with isolated workers
 *    - zcash: orchard shielded pool
 *    - penumbra: shielded dex
 *
 * 2. ibc/cosmos chains - same key derivation, different bech32 prefix
 *    - osmosis, noble, nomic, celestia
 *    - for penumbra deposits/withdrawals
 *
 * 3. substrate networks - polkadot/kusama umbrella for all parachains
 *    - same adapter, different ss58 prefixes per chain
 *    - hydration, acala, moonbeam etc are just chain configs
 *
 * 4. other transparent networks
 *    - ethereum, bitcoin
 *
 * The killer flow: BTC → Nomic (nBTC) → Penumbra (shielded)
 */

export type PrivacyNetwork = 'zcash' | 'penumbra';
export type IbcNetwork = 'osmosis' | 'noble' | 'nomic' | 'celestia';
export type TransparentNetwork = 'polkadot' | 'kusama' | 'ethereum' | 'bitcoin';
export type NetworkType = PrivacyNetwork | IbcNetwork | TransparentNetwork;

/**
 * encryption types - matches zigner's Encryption enum
 * same mnemonic can derive keys for any encryption type
 */
export type EncryptionType =
  | 'sr25519'        // substrate default (polkadot, kusama, parachains)
  | 'ed25519'        // substrate alt (native derivation)
  | 'ledger_ed25519' // substrate via ledger (SLIP-10/BIP32-Ed25519 derivation)
  | 'ecdsa'          // substrate alt, also ethereum compatible
  | 'penumbra'       // penumbra-specific derivation
  | 'zcash'          // ZIP-32 shielded derivation
  | 'cosmos'         // BIP44 secp256k1 with bech32
  | 'bitcoin'        // BIP-84 native segwit
  | 'ethereum';      // standard secp256k1

/**
 * substrate supports multiple encryption types per network
 * user chooses which to use based on their setup:
 *
 * - sr25519: default for hot wallets (most secure for substrate)
 * - ed25519: native ed25519 derivation
 * - ledger_ed25519: for Ledger hardware wallets (SLIP-10/BIP32-Ed25519)
 *   → users can add their Ledger wallet to zigner and use with zafu
 *   → same derivation path as Ledger app, so addresses match
 * - ecdsa: for EVM-compatible substrate chains (moonbeam etc)
 */
export const SUBSTRATE_ENCRYPTIONS: EncryptionType[] = ['sr25519', 'ed25519', 'ledger_ed25519', 'ecdsa'];

/** default encryption for each network type */
export const NETWORK_DEFAULT_ENCRYPTION: Record<NetworkType, EncryptionType> = {
  // privacy networks
  zcash: 'zcash',
  penumbra: 'penumbra',
  // ibc/cosmos - all use same cosmos encryption
  osmosis: 'cosmos',
  noble: 'cosmos',
  nomic: 'cosmos',
  celestia: 'cosmos',
  // substrate - default sr25519 (but ed25519/ecdsa also supported)
  polkadot: 'sr25519',
  kusama: 'sr25519',
  // others
  ethereum: 'ethereum',
  bitcoin: 'bitcoin',
};

/** check if network supports multiple encryption types */
export const isMultiEncryptionNetwork = (network: NetworkType): boolean => {
  return network === 'polkadot' || network === 'kusama';
};

/** get supported encryptions for a network */
export const getSupportedEncryptions = (network: NetworkType): EncryptionType[] => {
  if (isMultiEncryptionNetwork(network)) {
    return SUBSTRATE_ENCRYPTIONS;
  }
  return [NETWORK_DEFAULT_ENCRYPTION[network]];
};

export interface NetworkConfig {
  id: NetworkType;
  name: string;
  symbol: string;
  decimals: number;
  type: 'privacy' | 'ibc' | 'transparent';
  // for privacy networks
  syncRequired?: boolean;
  // address derivation
  derivationPath?: string;
  // chain-specific
  ss58Prefix?: number; // substrate
  chainId?: number; // evm
  bech32Prefix?: string; // cosmos/ibc
  denom?: string; // cosmos coin denom
}

export const NETWORK_CONFIGS: Record<NetworkType, NetworkConfig> = {
  // privacy networks - need local sync
  zcash: {
    id: 'zcash',
    name: 'Zcash',
    symbol: 'ZEC',
    decimals: 8,
    type: 'privacy',
    syncRequired: true,
  },
  penumbra: {
    id: 'penumbra',
    name: 'Penumbra',
    symbol: 'UM',
    decimals: 6,
    type: 'privacy',
    syncRequired: true,
    bech32Prefix: 'penumbra',
  },

  // ibc/cosmos chains - for penumbra deposits/withdrawals
  osmosis: {
    id: 'osmosis',
    name: 'Osmosis',
    symbol: 'OSMO',
    decimals: 6,
    type: 'ibc',
    bech32Prefix: 'osmo',
    denom: 'uosmo',
    derivationPath: "m/44'/118'/0'/0/0",
  },
  noble: {
    id: 'noble',
    name: 'Noble',
    symbol: 'USDC',
    decimals: 6,
    type: 'ibc',
    bech32Prefix: 'noble',
    denom: 'uusdc',
    derivationPath: "m/44'/118'/0'/0/0",
  },
  nomic: {
    id: 'nomic',
    name: 'Nomic',
    symbol: 'nBTC',
    decimals: 8,
    type: 'ibc',
    bech32Prefix: 'nomic',
    denom: 'usat',
    derivationPath: "m/44'/118'/0'/0/0",
  },
  celestia: {
    id: 'celestia',
    name: 'Celestia',
    symbol: 'TIA',
    decimals: 6,
    type: 'ibc',
    bech32Prefix: 'celestia',
    denom: 'utia',
    derivationPath: "m/44'/118'/0'/0/0",
  },

  // other transparent networks
  polkadot: {
    id: 'polkadot',
    name: 'Polkadot',
    symbol: 'DOT',
    decimals: 10,
    type: 'transparent',
    ss58Prefix: 0,
    derivationPath: "m/44'/354'/0'/0'/0'",
  },
  kusama: {
    id: 'kusama',
    name: 'Kusama',
    symbol: 'KSM',
    decimals: 12,
    type: 'transparent',
    ss58Prefix: 2,
    derivationPath: "m/44'/434'/0'/0'/0'",
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
    type: 'transparent',
    chainId: 1,
    derivationPath: "m/44'/60'/0'/0/0",
  },
  bitcoin: {
    id: 'bitcoin',
    name: 'Bitcoin',
    symbol: 'BTC',
    decimals: 8,
    type: 'transparent',
    derivationPath: "m/84'/0'/0'/0/0", // native segwit (bc1...)
  },
};

export const isPrivacyNetwork = (network: NetworkType): network is PrivacyNetwork => {
  return NETWORK_CONFIGS[network].type === 'privacy';
};

export const isIbcNetwork = (network: NetworkType): network is IbcNetwork => {
  return NETWORK_CONFIGS[network].type === 'ibc';
};

export const isTransparentNetwork = (network: NetworkType): network is TransparentNetwork => {
  return NETWORK_CONFIGS[network].type === 'transparent';
};

export const getNetworkConfig = (network: NetworkType): NetworkConfig => {
  return NETWORK_CONFIGS[network];
};

/** get default encryption type for a network */
export const getNetworkEncryption = (network: NetworkType): EncryptionType => {
  return NETWORK_DEFAULT_ENCRYPTION[network];
};

/**
 * substrate chain config - parachains under polkadot/kusama umbrella
 *
 * users interact with these via the polkadot/kusama network
 * same key derivation, different ss58 prefix and rpc endpoint
 */
export interface SubstrateChainConfig {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  ss58Prefix: number;
  /** parent relay: polkadot or kusama */
  relay: 'polkadot' | 'kusama';
  /** parachain id (null for relay chain) */
  paraId: number | null;
  /** default rpc endpoint */
  rpcEndpoint: string;
}

/**
 * common substrate chains
 * users can add custom chains via settings
 */
export const SUBSTRATE_CHAINS: SubstrateChainConfig[] = [
  // polkadot relay
  {
    id: 'polkadot',
    name: 'Polkadot',
    symbol: 'DOT',
    decimals: 10,
    ss58Prefix: 0,
    relay: 'polkadot',
    paraId: null,
    rpcEndpoint: 'wss://rpc.polkadot.io',
  },
  // polkadot parachains
  {
    id: 'hydration',
    name: 'Hydration',
    symbol: 'HDX',
    decimals: 12,
    ss58Prefix: 63,
    relay: 'polkadot',
    paraId: 2034,
    rpcEndpoint: 'wss://rpc.hydradx.cloud',
  },
  {
    id: 'acala',
    name: 'Acala',
    symbol: 'ACA',
    decimals: 12,
    ss58Prefix: 10,
    relay: 'polkadot',
    paraId: 2000,
    rpcEndpoint: 'wss://acala-rpc.dwellir.com',
  },
  {
    id: 'moonbeam',
    name: 'Moonbeam',
    symbol: 'GLMR',
    decimals: 18,
    ss58Prefix: 1284,
    relay: 'polkadot',
    paraId: 2004,
    rpcEndpoint: 'wss://wss.api.moonbeam.network',
  },
  {
    id: 'astar',
    name: 'Astar',
    symbol: 'ASTR',
    decimals: 18,
    ss58Prefix: 5,
    relay: 'polkadot',
    paraId: 2006,
    rpcEndpoint: 'wss://rpc.astar.network',
  },
  // kusama relay
  {
    id: 'kusama',
    name: 'Kusama',
    symbol: 'KSM',
    decimals: 12,
    ss58Prefix: 2,
    relay: 'kusama',
    paraId: null,
    rpcEndpoint: 'wss://kusama-rpc.polkadot.io',
  },
  // kusama parachains
  {
    id: 'karura',
    name: 'Karura',
    symbol: 'KAR',
    decimals: 12,
    ss58Prefix: 8,
    relay: 'kusama',
    paraId: 2000,
    rpcEndpoint: 'wss://karura-rpc.dwellir.com',
  },
  {
    id: 'moonriver',
    name: 'Moonriver',
    symbol: 'MOVR',
    decimals: 18,
    ss58Prefix: 1285,
    relay: 'kusama',
    paraId: 2023,
    rpcEndpoint: 'wss://wss.api.moonriver.moonbeam.network',
  },
];

export const getSubstrateChain = (chainId: string): SubstrateChainConfig | undefined => {
  return SUBSTRATE_CHAINS.find(c => c.id === chainId);
};

export const getSubstrateChainsByRelay = (relay: 'polkadot' | 'kusama'): SubstrateChainConfig[] => {
  return SUBSTRATE_CHAINS.filter(c => c.relay === relay);
};

/** check if network type is substrate-based */
export const isSubstrateNetwork = (network: NetworkType): network is 'polkadot' | 'kusama' => {
  return network === 'polkadot' || network === 'kusama';
};
