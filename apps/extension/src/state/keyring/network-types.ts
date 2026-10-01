/**
 * network type definitions
 *
 * aligned with zigner encryption types - same key can sign for any
 * network with matching encryption algorithm
 *
 * encryption types (matching zigner's Encryption enum):
 * - penumbra: shielded dex
 * - zcash: ZIP-32 derivation for shielded txs
 * - cosmos: BIP44 secp256k1 (noble, cosmoshub)
 * - bitcoin: BIP-84 native segwit
 * - ethereum: standard secp256k1
 *
 * network categories:
 *
 * 1. privacy networks - need local sync with isolated workers
 *    - zcash: orchard shielded pool
 *    - penumbra: shielded dex
 *
 * 2. ibc/cosmos chains - subnetworks reached over IBC from Penumbra
 *    - noble, cosmoshub: standard cosmos secp256k1, coin type 118
 *    - injective: Ethermint (eth_secp256k1, coin type 60) - a receive+shield
 *      USDC ramp only; derives/signs via networks/injective, NOT the shared
 *      coin-118 cosmos path (guarded in deriveChainAddress). Launched:true.
 *
 * 3. other transparent networks
 *    - ethereum, bitcoin
 */

export type PrivacyNetwork = 'zcash' | 'penumbra';
export type IbcNetwork = 'noble' | 'cosmoshub' | 'osmosis' | 'injective';
export type TransparentNetwork = 'ethereum' | 'bitcoin';
export type NetworkType = PrivacyNetwork | IbcNetwork | TransparentNetwork;

/**
 * encryption types - matches zigner's Encryption enum
 * same mnemonic can derive keys for any encryption type
 */
export type EncryptionType =
  | 'penumbra' // penumbra-specific derivation
  | 'zcash' // ZIP-32 shielded derivation
  | 'cosmos' // BIP44 secp256k1 with bech32
  | 'bitcoin' // BIP-84 native segwit
  | 'ethereum'; // standard secp256k1

/** default encryption for each network type */
export const NETWORK_DEFAULT_ENCRYPTION: Record<NetworkType, EncryptionType> = {
  // privacy networks
  zcash: 'zcash',
  penumbra: 'penumbra',
  // ibc/cosmos - all use same cosmos encryption
  noble: 'cosmos',
  cosmoshub: 'cosmos',
  osmosis: 'cosmos',
  // injective is Ethermint: eth_secp256k1 (ethereum curve + keccak), not the
  // cosmos secp256k1 path - so its encryption type is ethereum.
  injective: 'ethereum',
  // others
  ethereum: 'ethereum',
  bitcoin: 'bitcoin',
};

/** get supported encryptions for a network */
export const getSupportedEncryptions = (network: NetworkType): EncryptionType[] => {
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
  cosmoshub: {
    id: 'cosmoshub',
    name: 'Cosmos Hub',
    symbol: 'ATOM',
    decimals: 6,
    type: 'ibc',
    bech32Prefix: 'cosmos',
    denom: 'uatom',
    derivationPath: "m/44'/118'/0'/0/0",
  },
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
  injective: {
    id: 'injective',
    name: 'Injective',
    // ramp asset is Circle-native USDC on Injective (USDC.inj), 6-dec. Gas is a
    // separate token (INJ, 18-dec) - see COSMOS_CHAINS.injective.gasAsset.
    symbol: 'USDC.inj',
    decimals: 6,
    type: 'ibc',
    bech32Prefix: 'inj',
    denom: 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a',
    // Ethermint: coin type 60 (NOT 118). Derives/signs via networks/injective.
    derivationPath: "m/44'/60'/0'/0/0",
  },

  // other transparent networks
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
