/**
 * cosmos chain registry
 *
 * chains we currently relay IBC packets for between Penumbra and:
 * - noble: native USDC issuance
 * - cosmoshub: ATOM, the Cosmos Hub
 *
 * other cosmos chains (osmosis, nomic, celestia) were previously listed
 * but are not part of the active relay set; their entries can be re-added
 * when those channels open.
 *
 * all use same key derivation (m/44'/118'/0'/0/0) with different bech32 prefix
 */

export type CosmosChainId =
  | 'noble'
  | 'cosmoshub';

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
    penumbraChannel: 'channel-89', // noble -> penumbra
    penumbraSourceChannel: 'channel-2', // penumbra -> noble
  },
  cosmoshub: {
    id: 'cosmoshub',
    name: 'Cosmos Hub',
    chainId: 'cosmoshub-4',
    bech32Prefix: 'cosmos',
    symbol: 'ATOM',
    denom: 'uatom',
    decimals: 6,
    rpcEndpoint: 'https://cosmos-rpc.polkachu.com',
    restEndpoint: 'https://cosmos-api.polkachu.com',
    gasPrice: '0.025uatom',
    penumbraChannel: 'channel-940', // cosmoshub -> penumbra
    penumbraSourceChannel: 'channel-0', // penumbra -> cosmoshub
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
