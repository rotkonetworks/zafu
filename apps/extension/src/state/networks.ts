import { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';

/**
 * Supported network ecosystems.
 *
 * Privacy networks (zcash, penumbra): require trusted sync endpoint
 * IBC chains (osmosis, noble, nomic, celestia): cosmos-sdk chains for IBC transfers
 * Transparent networks (polkadot, ethereum): simple RPC balance queries
 *
 * Core focus:
 * - Penumbra: private DEX, shielded assets
 * - Zcash: shielded ZEC
 * - Nomic: Bitcoin bridge (nBTC) - deposit/withdraw BTC
 * - Osmosis: DEX, IBC routing hub
 * - Noble: USDC native issuance
 * - Celestia: DA layer, TIA
 *
 * The killer flow: BTC → Nomic (nBTC) → Penumbra (shielded nBTC)
 */
export type NetworkId =
  // privacy networks (local sync required)
  | 'penumbra'
  | 'zcash'
  // ibc/cosmos chains (for penumbra deposits/withdrawals)
  | 'osmosis'
  | 'noble'
  | 'nomic'
  | 'celestia'
  // other transparent networks
  | 'polkadot'
  | 'kusama'
  | 'ethereum'
  | 'bitcoin';

export interface NetworkConfig {
  id: NetworkId;
  name: string;
  enabled: boolean;
  /** Network-specific RPC/node endpoint */
  endpoint?: string;
  /** REST/LCD endpoint for cosmos chains */
  restEndpoint?: string;
  /** Chain ID */
  chainId?: string;
  /** Whether this network requires a trusted sync endpoint (privacy networks) */
  requiresTrustedEndpoint?: boolean;
  /** Whether this is a cosmos/IBC chain */
  isIbcChain?: boolean;
  /** Bech32 address prefix for cosmos chains */
  bech32Prefix?: string;
  /** Symbol for display */
  symbol: string;
  /** Decimals */
  decimals: number;
  /** Coin denom (e.g., uosmo, unom) */
  denom?: string;
}

export interface NetworksSlice {
  /** Map of network ID to configuration */
  networks: Record<NetworkId, NetworkConfig>;
  /** Enable a network (triggers adapter loading) */
  enableNetwork: (id: NetworkId) => Promise<void>;
  /** Disable a network */
  disableNetwork: (id: NetworkId) => Promise<void>;
  /** Update network endpoint */
  setNetworkEndpoint: (id: NetworkId, endpoint: string) => Promise<void>;
  /** Get list of enabled networks */
  getEnabledNetworks: () => NetworkConfig[];
  /** Check if a network is enabled */
  isNetworkEnabled: (id: NetworkId) => boolean;
}

const DEFAULT_NETWORKS: Record<NetworkId, NetworkConfig> = {
  // === Privacy Networks (require trusted sync endpoint) ===
  penumbra: {
    id: 'penumbra',
    name: 'Penumbra',
    symbol: 'UM',
    decimals: 6,
    denom: 'upenumbra',
    enabled: false,
    endpoint: 'https://penumbra.rotko.net',
    chainId: 'penumbra-1',
    requiresTrustedEndpoint: true,
    bech32Prefix: 'penumbra',
  },
  zcash: {
    id: 'zcash',
    name: 'Zcash',
    symbol: 'ZEC',
    decimals: 8,
    enabled: false,
    // zidecar endpoint - our own trustless sync server
    endpoint: 'https://zcash.rotko.net',
    requiresTrustedEndpoint: true,
  },

  // === IBC/Cosmos Chains (for Penumbra deposits/withdrawals) ===
  osmosis: {
    id: 'osmosis',
    name: 'Osmosis',
    symbol: 'OSMO',
    decimals: 6,
    denom: 'uosmo',
    enabled: false,
    endpoint: 'https://rpc.osmosis.zone',
    restEndpoint: 'https://lcd.osmosis.zone',
    chainId: 'osmosis-1',
    isIbcChain: true,
    bech32Prefix: 'osmo',
  },
  noble: {
    id: 'noble',
    name: 'Noble',
    symbol: 'USDC',
    decimals: 6,
    denom: 'uusdc', // native USDC
    enabled: false,
    endpoint: 'https://rpc.noble.strange.love',
    restEndpoint: 'https://noble-api.polkachu.com',
    chainId: 'noble-1',
    isIbcChain: true,
    bech32Prefix: 'noble',
  },
  nomic: {
    id: 'nomic',
    name: 'Nomic (nBTC)',
    symbol: 'nBTC',
    decimals: 8, // satoshis like bitcoin
    denom: 'usat',
    enabled: false,
    endpoint: 'https://rpc.nomic.io',
    restEndpoint: 'https://app.nomic.io:8443', // relayer endpoint for deposits
    chainId: 'nomic-stakenet-3',
    isIbcChain: true,
    bech32Prefix: 'nomic',
  },
  celestia: {
    id: 'celestia',
    name: 'Celestia',
    symbol: 'TIA',
    decimals: 6,
    denom: 'utia',
    enabled: false,
    endpoint: 'https://rpc.celestia.strange.love',
    restEndpoint: 'https://celestia-api.polkachu.com',
    chainId: 'celestia',
    isIbcChain: true,
    bech32Prefix: 'celestia',
  },

  // === Other Transparent Networks ===
  polkadot: {
    id: 'polkadot',
    name: 'Polkadot',
    symbol: 'DOT',
    decimals: 10,
    enabled: false,
    endpoint: 'wss://rpc.polkadot.io',
  },
  kusama: {
    id: 'kusama',
    name: 'Kusama',
    symbol: 'KSM',
    decimals: 12,
    enabled: false,
    endpoint: 'wss://kusama-rpc.polkadot.io',
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
    enabled: false,
    endpoint: 'https://eth.llamarpc.com',
    chainId: '1',
  },
  bitcoin: {
    id: 'bitcoin',
    name: 'Bitcoin',
    symbol: 'BTC',
    decimals: 8,
    enabled: false,
    // mempool.space for balance queries and tx broadcast
    endpoint: 'https://mempool.space',
  },
};

export const createNetworksSlice =
  (local: ExtensionStorage<LocalStorageState>): SliceCreator<NetworksSlice> =>
  (set, get) => {
    // Hydrate networks from storage on init
    void (async () => {
      const enabledNetworks = await local.get('enabledNetworks');
      const networkEndpoints = await local.get('networkEndpoints');

      if (enabledNetworks || networkEndpoints) {
        set(state => {
          // Apply enabled state from storage
          if (enabledNetworks) {
            for (const id of enabledNetworks) {
              if (state.networks.networks[id as NetworkId]) {
                state.networks.networks[id as NetworkId].enabled = true;
              }
            }
          }
          // Apply custom endpoints from storage
          if (networkEndpoints) {
            for (const [id, endpoint] of Object.entries(networkEndpoints)) {
              if (state.networks.networks[id as NetworkId]) {
                state.networks.networks[id as NetworkId].endpoint = endpoint as string;
              }
            }
          }
        });
      }
    })();

    return {
      networks: DEFAULT_NETWORKS,

      enableNetwork: async (id: NetworkId) => {
        set(state => {
          state.networks.networks[id].enabled = true;
        });

        const networks = get().networks.networks;
        await local.set('enabledNetworks',
          Object.values(networks)
            .filter(n => n.enabled)
            .map(n => n.id)
        );

        // TODO: Trigger lazy loading of network adapter
        console.log(`Network ${id} enabled - adapter will be loaded`);
      },

      disableNetwork: async (id: NetworkId) => {
        // Check if any wallets still use this network
        const wallets = get().wallets.all;
        const hasWalletsOnNetwork = wallets.some(_w => {
          // TODO: Add network field to wallet type
          return false;
        });

        if (hasWalletsOnNetwork) {
          throw new Error(`Cannot disable ${id} - wallets still exist on this network`);
        }

        set(state => {
          state.networks.networks[id].enabled = false;
        });

        const networks = get().networks.networks;
        await local.set('enabledNetworks',
          Object.values(networks)
            .filter(n => n.enabled)
            .map(n => n.id)
        );

        // TODO: Unload network adapter to free memory
        console.log(`Network ${id} disabled - adapter unloaded`);
      },

      setNetworkEndpoint: async (id: NetworkId, endpoint: string) => {
        set(state => {
          state.networks.networks[id].endpoint = endpoint;
        });

        // Persist endpoint changes using networkEndpoints object
        const currentEndpoints = await local.get('networkEndpoints') || {};
        await local.set('networkEndpoints', {
          ...currentEndpoints,
          [id]: endpoint,
        });
      },

      getEnabledNetworks: () => {
        return Object.values(get().networks.networks).filter(n => n.enabled);
      },

      isNetworkEnabled: (id: NetworkId) => {
        return get().networks.networks[id].enabled;
      },
    };
  };

export const networksSelector = (state: AllSlices) => state.networks;
export const enabledNetworksSelector = (state: AllSlices) =>
  Object.values(state.networks.networks).filter(n => n.enabled);
