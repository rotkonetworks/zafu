/**
 * keyring types - keplr-style multi-account model
 *
 * each keyinfo represents a "vault" (seed phrase, zigner zafu, or ledger)
 * that can derive keys for multiple networks
 *
 * networks fall into two categories:
 * - privacy: need local sync (zcash, penumbra) - run in isolated workers
 * - transparent: rpc only (polkadot, ethereum) - no local state needed
 */

export type KeyType = 'mnemonic' | 'zigner-zafu' | 'ledger';

// re-export from network-types for convenience
import type { NetworkType as NetworkTypeImport } from './network-types';
export type { NetworkType, PrivacyNetwork, IbcNetwork, TransparentNetwork, SubstrateChainConfig, EncryptionType } from './network-types';
export {
  isPrivacyNetwork,
  isIbcNetwork,
  isTransparentNetwork,
  isSubstrateNetwork,
  isMultiEncryptionNetwork,
  getNetworkEncryption,
  getSupportedEncryptions,
  NETWORK_CONFIGS,
  NETWORK_DEFAULT_ENCRYPTION,
  SUBSTRATE_ENCRYPTIONS,
  SUBSTRATE_CHAINS,
  getSubstrateChain,
  getSubstrateChainsByRelay,
} from './network-types';

// local alias for use in this file
type NetworkType = NetworkTypeImport;

export interface KeyInfo {
  /** unique vault id */
  id: string;
  /** user-defined name */
  name: string;
  /** key type */
  type: KeyType;
  /** is this the currently selected account */
  isSelected: boolean;
  /** creation timestamp */
  createdAt: number;
  /** per-network metadata (non-sensitive) */
  insensitive: Record<string, unknown>;
}

/** derived key for a specific network */
export interface DerivedKey {
  keyInfoId: string;
  network: NetworkType;
  /** bech32 or hex address depending on network */
  address: string;
  /** bip44 derivation path used */
  derivationPath: string;
  /** account index (for multiple accounts per network) */
  accountIndex: number;
}

/** network derivation config */
export interface NetworkDerivation {
  network: NetworkType;
  /** bip44 coin type */
  coinType: number;
  /** default derivation path template */
  pathTemplate: string;
  /** address prefix if applicable */
  prefix?: string;
}

/** standard derivation paths per network */
export const NETWORK_DERIVATIONS: Partial<Record<NetworkType, NetworkDerivation>> = {
  // privacy networks
  penumbra: {
    network: 'penumbra',
    coinType: 6532, // penumbra coin type
    pathTemplate: "m/44'/6532'/0'",
    prefix: 'penumbra',
  },
  zcash: {
    network: 'zcash',
    coinType: 133,
    pathTemplate: "m/44'/133'/0'/0/0",
    prefix: 'u', // unified address
  },
  // ibc/cosmos chains - all use cosmos coin type 118
  osmosis: {
    network: 'osmosis',
    coinType: 118,
    pathTemplate: "m/44'/118'/0'/0/0",
    prefix: 'osmo',
  },
  noble: {
    network: 'noble',
    coinType: 118,
    pathTemplate: "m/44'/118'/0'/0/0",
    prefix: 'noble',
  },
  nomic: {
    network: 'nomic',
    coinType: 118,
    pathTemplate: "m/44'/118'/0'/0/0",
    prefix: 'nomic',
  },
  celestia: {
    network: 'celestia',
    coinType: 118,
    pathTemplate: "m/44'/118'/0'/0/0",
    prefix: 'celestia',
  },
  // transparent networks
  polkadot: {
    network: 'polkadot',
    coinType: 354,
    pathTemplate: "m/44'/354'/0'/0'/0'",
    prefix: '1', // polkadot ss58
  },
  kusama: {
    network: 'kusama',
    coinType: 434,
    pathTemplate: "m/44'/434'/0'/0'/0'",
    prefix: 'C', // kusama ss58
  },
  ethereum: {
    network: 'ethereum',
    coinType: 60,
    pathTemplate: "m/44'/60'/0'/0/0",
    prefix: '0x',
  },
};

/** keyring status */
export type KeyRingStatus = 'not-loaded' | 'empty' | 'locked' | 'unlocked';

/** encrypted vault data stored in local storage */
export interface EncryptedVault {
  id: string;
  type: KeyType;
  name: string;
  createdAt: number;
  /** encrypted mnemonic or zigner metadata */
  encryptedData: string;
  /** key derivation salt */
  salt: string;
  /** per-network insensitive data */
  insensitive: Record<string, unknown>;
}

/** zigner zafu import data (watch-only) */
export interface ZignerZafuImport {
  /** full viewing key for penumbra */
  fullViewingKey?: string;
  /** viewing key for zcash */
  viewingKey?: string;
  /** public key for other networks */
  publicKey?: string;
  /** ss58 address for polkadot/kusama (watch-only) */
  polkadotSs58?: string;
  /** genesis hash for the polkadot network */
  polkadotGenesisHash?: string;
  /** cosmos chain addresses (watch-only) */
  cosmosAddresses?: { chainId: string; address: string; prefix: string }[];
  /** account index on zafu device */
  accountIndex: number;
  /** device identifier */
  deviceId: string;
}

/**
 * network activation state
 *
 * a network is only "active" (APIs injected, features loaded) if:
 * 1. user has at least one derived key for that network
 * 2. network is in enabledNetworks list
 *
 * this prevents leaking wallet presence to dapps for unused networks
 */
export interface NetworkActivation {
  network: NetworkType;
  /** has at least one key derived */
  hasKeys: boolean;
  /** user has enabled this network */
  isEnabled: boolean;
  /** should inject provider API to pages */
  shouldInjectProvider: boolean;
  /** should load WASM/features */
  shouldLoadFeatures: boolean;
}

/** derive network activation from vault data */
export const getNetworkActivation = (
  network: NetworkType,
  enabledNetworks: NetworkType[],
  derivedKeys: DerivedKey[],
): NetworkActivation => {
  const hasKeys = derivedKeys.some(k => k.network === network);
  const isEnabled = enabledNetworks.includes(network);

  return {
    network,
    hasKeys,
    isEnabled,
    // only inject if user has keys AND enabled
    shouldInjectProvider: hasKeys && isEnabled,
    // only load features if enabled (may lazy create keys later)
    shouldLoadFeatures: isEnabled,
  };
};
