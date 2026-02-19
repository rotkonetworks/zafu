/**
 * cosmos chain registry
 *
 * chains we care about for penumbra integration:
 * - osmosis: DEX hub, IBC routing
 * - noble: native USDC issuance
 * - nomic: bitcoin bridge (nBTC)
 * - celestia: DA layer
 *
 * all use same key derivation (m/44'/118'/0'/0/0) with different bech32 prefix
 */

export type CosmosChainId =
  | 'osmosis'
  | 'noble'
  | 'nomic'
  | 'celestia';

export interface CosmosChainConfig {
  id: CosmosChainId;
  name: string;
  /** chain-id from genesis */
  chainId: string;
  /** bech32 address prefix */
  bech32Prefix: string;
  /** native token symbol */
  symbol: string;
  /** native token denom (for bank queries) */
  denom: string;
  /** decimal places */
  decimals: number;
  /** RPC endpoint */
  rpcEndpoint: string;
  /** REST/LCD endpoint */
  restEndpoint: string;
  /** gas price in native denom */
  gasPrice: string;
  /** IBC channel on the cosmos chain pointing to penumbra */
  penumbraChannel?: string;
  /** IBC channel on penumbra pointing to this chain (for IBC withdrawals) */
  penumbraSourceChannel?: string;
}

export const COSMOS_CHAINS: Record<CosmosChainId, CosmosChainConfig> = {
  osmosis: {
    id: 'osmosis',
    name: 'Osmosis',
    chainId: 'osmosis-1',
    bech32Prefix: 'osmo',
    symbol: 'OSMO',
    denom: 'uosmo',
    decimals: 6,
    rpcEndpoint: 'https://rpc.osmosis.zone',
    restEndpoint: 'https://lcd.osmosis.zone',
    gasPrice: '0.025uosmo',
    penumbraChannel: 'channel-1279', // osmosis -> penumbra
  },
  noble: {
    id: 'noble',
    name: 'Noble',
    chainId: 'noble-1',
    bech32Prefix: 'noble',
    symbol: 'USDC',
    denom: 'uusdc',
    decimals: 6,
    rpcEndpoint: 'https://noble-rpc.polkachu.com',
    restEndpoint: 'https://noble-api.polkachu.com',
    gasPrice: '0.1uusdc',
    penumbraChannel: 'channel-4', // noble -> penumbra
  },
  nomic: {
    id: 'nomic',
    name: 'Nomic',
    chainId: 'nomic-stakenet-3',
    bech32Prefix: 'nomic',
    symbol: 'nBTC',
    denom: 'usat', // micro-satoshis
    decimals: 6, // usat has 6 decimals (1 nBTC = 1e6 usat = 1e8 satoshis)
    rpcEndpoint: 'https://rpc.nomic.io',
    restEndpoint: 'https://app.nomic.io:8443',
    gasPrice: '0unom', // nomic uses NOM for gas, but simple transfers are often free
  },
  celestia: {
    id: 'celestia',
    name: 'Celestia',
    chainId: 'celestia',
    bech32Prefix: 'celestia',
    symbol: 'TIA',
    denom: 'utia',
    decimals: 6,
    rpcEndpoint: 'https://celestia-rpc.polkachu.com',
    restEndpoint: 'https://celestia-api.polkachu.com',
    gasPrice: '0.002utia',
  },
};

/** get chain config by id */
export function getCosmosChain(id: CosmosChainId): CosmosChainConfig {
  return COSMOS_CHAINS[id];
}

/** get all chain ids */
export function getAllCosmosChainIds(): CosmosChainId[] {
  return Object.keys(COSMOS_CHAINS) as CosmosChainId[];
}

/** validate bech32 address for any supported chain */
export function isValidCosmosAddress(address: string): boolean {
  return Object.values(COSMOS_CHAINS).some(
    chain => address.startsWith(`${chain.bech32Prefix}1`)
  );
}

/** get chain from address prefix */
export function getChainFromAddress(address: string): CosmosChainConfig | undefined {
  return Object.values(COSMOS_CHAINS).find(
    chain => address.startsWith(`${chain.bech32Prefix}1`)
  );
}
