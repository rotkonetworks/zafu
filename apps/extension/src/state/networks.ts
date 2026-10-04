import { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import {
  backendKey,
  backendOfEndpoint,
  createRedetector,
  isZcashBackend,
  type ZcashBackend,
} from './keyring/zcash-backend';

/**
 * Supported network ecosystems.
 *
 * Privacy networks (zcash, penumbra): require trusted sync endpoint
 * IBC chains (noble, cosmoshub): cosmos-sdk chains for IBC transfers
 * Transparent networks (ethereum): simple RPC balance queries
 *
 * Core focus:
 * - Penumbra: private DEX, shielded assets
 * - Zcash: shielded ZEC
 * - Noble: USDC native issuance, IBC bridge into Penumbra
 * - Cosmos Hub: ATOM, IBC bridge into Penumbra
 */
export type NetworkId =
  // privacy networks (local sync required)
  | 'penumbra'
  | 'zcash'
  // ibc/cosmos chains (for penumbra deposits/withdrawals)
  | 'noble'
  | 'cosmoshub'
  // other transparent networks
  | 'ethereum'
  | 'bitcoin';

/**
 * Strategy for fetching memos on shielded networks. Per-server because the
 * tradeoff (privacy vs bandwidth) makes sense to tune differently for a
 * public server you don't trust versus a self-hosted node you do.
 *
 * See apps/extension/src/services/memo-sync/README.md for what each strategy
 * does. No strategy ever exposes per-txid lookups; the leaky path is
 * deliberately not reachable from the UI.
 */
export type MemoSyncStrategy = 'private' | 'fast';

/**
 * Mempool-watch toggle. Off by default (per the hdevalence review): the
 * feature has a real privacy cost - the indexer learns the wallet is online
 * and polls on a regular cadence. Users opt in explicitly.
 *
 * See apps/extension/src/services/mempool-watch/README.md for the design.
 */
export type MempoolWatchSetting = 'off' | 'on';

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
  /** Short description of the sync model shown in endpoint settings */
  syncDescription?: string;
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
  /**
   * Memo-fetch strategy for shielded networks. Optional because non-shielded
   * networks don't have memos. Default 'private' is set explicitly on the
   * Zcash entry so it always persists.
   */
  memoSyncStrategy?: MemoSyncStrategy;
  /**
   * Mempool watch toggle for shielded networks. Off by default - opening
   * a polling subscription reveals to the indexer that this wallet is
   * online and continuously interested in mempool state. See README.
   * Honored only where the backend has zidecar's mempool rpc
   * (isMempoolWatchEnabled); the UI hides the toggle otherwise.
   */
  mempoolWatch?: MempoolWatchSetting;
  /**
   * What kind of node the endpoint is. Never asked of the user: the node
   * says, through the standard GetLightdInfo (see detectZcashBackend), and
   * the answer is cached per endpoint. Until it has answered this is a
   * guess (backendOfEndpoint, or what an older build stored) that never
   * reads a third-party node as zidecar. What differs per backend lives in
   * ZCASH_BACKENDS.
   */
  backend?: ZcashBackend;
  /** true once the endpoint itself said what it is */
  backendDetected?: boolean;
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
  /** Update memo-sync strategy for a shielded network. */
  setMemoSyncStrategy: (id: NetworkId, strategy: MemoSyncStrategy) => Promise<void>;
  /** Update mempool-watch toggle for a shielded network. */
  setMempoolWatch: (id: NetworkId, setting: MempoolWatchSetting) => Promise<void>;
  /** record what a zcash node said it is (cached per endpoint) */
  noteZcashBackend: (serverUrl: string, backend: ZcashBackend) => Promise<void>;
  /** one of zidecar's own calls failed: ask the node again what it is */
  redetectZcashBackend: (serverUrl: string) => Promise<void>;
  /** Get list of enabled networks */
  getEnabledNetworks: () => NetworkConfig[];
  /** Check if a network is enabled */
  isNetworkEnabled: (id: NetworkId) => boolean;
}

const DEFAULT_NETWORKS: Record<NetworkId, NetworkConfig> = {
  // === Privacy Networks (compact block sync, client-side decryption) ===
  penumbra: {
    id: 'penumbra',
    name: 'Penumbra',
    symbol: 'UM',
    decimals: 6,
    denom: 'upenumbra',
    enabled: false,
    endpoint: 'https://penumbra.rotko.net',
    chainId: 'penumbra-1',
    syncDescription:
      'Compact blocks verified by state commitment tree. Trial-decrypted locally - keys never leave this device.',
    bech32Prefix: 'penumbra',
  },
  zcash: {
    id: 'zcash',
    name: 'Zcash',
    symbol: 'ZEC',
    decimals: 8,
    enabled: false,
    endpoint: 'https://zcash.rotko.net',
    syncDescription:
      'Zidecar trustless sync - header chain proven via Ligerito polynomial commitments, nullifier set verified by NOMT merkle proofs. Compact blocks are trial-decrypted locally - keys never leave this device.',
    memoSyncStrategy: 'private',
    mempoolWatch: 'off',
    backend: 'zidecar',
  },

  // === IBC/Cosmos Chains (for Penumbra deposits/withdrawals) ===
  noble: {
    id: 'noble',
    name: 'Noble',
    symbol: 'USDC',
    decimals: 6,
    denom: 'uusdc', // native USDC
    enabled: false,
    endpoint: 'https://noble-rpc.polkachu.com',
    restEndpoint: 'https://noble-api.polkachu.com',
    chainId: 'noble-1',
    isIbcChain: true,
    bech32Prefix: 'noble',
  },
  cosmoshub: {
    id: 'cosmoshub',
    name: 'Cosmos Hub',
    symbol: 'ATOM',
    decimals: 6,
    denom: 'uatom',
    enabled: false,
    endpoint: 'https://cosmos-rpc.polkachu.com',
    restEndpoint: 'https://cosmos-api.polkachu.com',
    chainId: 'cosmoshub-4',
    isIbcChain: true,
    bech32Prefix: 'cosmos',
  },

  // === Other Transparent Networks ===
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
    // the zcash worker asks a node what it is at sync start, and again when a
    // zidecar call fails; it relays the answer here to be cached
    if (typeof window !== 'undefined') {
      window.addEventListener('zcash-backend-detected', e => {
        const { serverUrl, backend } = (
          e as CustomEvent<{ serverUrl?: unknown; backend?: unknown }>
        ).detail;
        if (typeof serverUrl === 'string' && isZcashBackend(backend)) {
          void get().networks.noteZcashBackend(serverUrl, backend);
        }
      });
    }
    // Hydrate networks from storage on init
    void (async () => {
      const enabledNetworks = await local.get('enabledNetworks');
      const networkEndpoints = await local.get('networkEndpoints');
      const memoSyncStrategies = await local.get('memoSyncStrategies');
      const mempoolWatchSettings = await local.get('mempoolWatchSettings');
      const zcashBackend = await local.get('zcashBackend');
      const zcashBackends = await local.get('zcashBackends');

      if (
        enabledNetworks ||
        networkEndpoints ||
        memoSyncStrategies ||
        mempoolWatchSettings ||
        zcashBackend ||
        zcashBackends
      ) {
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
                state.networks.networks[id as NetworkId].endpoint = endpoint;
              }
            }
          }
          // Apply per-network memo sync strategies
          if (memoSyncStrategies) {
            for (const [id, strategy] of Object.entries(memoSyncStrategies)) {
              const cfg = state.networks.networks[id as NetworkId];
              if (cfg && strategy) {
                cfg.memoSyncStrategy = strategy as MemoSyncStrategy;
              }
            }
          }
          // Apply per-network mempool-watch settings (defensively: ignore
          // values not in the known enum; guards against tampered storage).
          if (mempoolWatchSettings) {
            for (const [id, setting] of Object.entries(mempoolWatchSettings)) {
              const cfg = state.networks.networks[id as NetworkId];
              if (cfg && (setting === 'off' || setting === 'on')) {
                cfg.mempoolWatch = setting;
              }
            }
          }
          // the node's own answer, when it has given one; otherwise what an
          // older build stored (its guess, or a kind the user once picked)
          // stands until the node answers, then the guess
          const zcash = state.networks.networks.zcash;
          const detected = zcashBackends?.[backendKey(zcash.endpoint ?? '')];
          if (isZcashBackend(detected)) {
            zcash.backend = detected;
            zcash.backendDetected = true;
          } else if (isZcashBackend(zcashBackend)) {
            zcash.backend = zcashBackend;
          } else {
            zcash.backend = backendOfEndpoint(zcash.endpoint ?? '');
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
        await local.set(
          'enabledNetworks',
          Object.values(networks)
            .filter(n => n.enabled)
            .map(n => n.id),
        );

        // TODO: Trigger lazy loading of network adapter
        console.log(`Network ${id} enabled - adapter will be loaded`);
      },

      disableNetwork: async (id: NetworkId) => {
        set(state => {
          state.networks.networks[id].enabled = false;
        });

        const networks = get().networks.networks;
        await local.set(
          'enabledNetworks',
          Object.values(networks)
            .filter(n => n.enabled)
            .map(n => n.id),
        );

        // TODO: Unload network adapter to free memory
        console.log(`Network ${id} disabled - adapter unloaded`);
      },

      setNetworkEndpoint: async (id: NetworkId, endpoint: string) => {
        set(state => {
          state.networks.networks[id].endpoint = endpoint;
        });

        // Persist endpoint changes using networkEndpoints object
        const currentEndpoints = (await local.get('networkEndpoints')) || {};
        await local.set('networkEndpoints', {
          ...currentEndpoints,
          [id]: endpoint,
        });

        // what this node said last time, else a guess; the sync asks the
        // node itself (standard GetLightdInfo) when nothing is cached
        if (id === 'zcash') {
          const cached = (await local.get('zcashBackends'))?.[backendKey(endpoint)];
          const backend = isZcashBackend(cached) ? cached : backendOfEndpoint(endpoint);
          set(state => {
            state.networks.networks.zcash.backend = backend;
            state.networks.networks.zcash.backendDetected = isZcashBackend(cached);
          });
          await local.set('zcashBackend', backend);
        }
      },

      noteZcashBackend: async (serverUrl: string, backend: ZcashBackend) => {
        if (!isZcashBackend(backend)) {
          return;
        }
        const key = backendKey(serverUrl);
        const cache = (await local.get('zcashBackends')) ?? {};
        if (cache[key] !== backend) {
          await local.set('zcashBackends', { ...cache, [key]: backend });
        }
        const zcash = get().networks.networks.zcash;
        if (backendKey(zcash.endpoint ?? '') !== key) {
          return;
        }
        if (zcash.backend !== backend || !zcash.backendDetected) {
          set(state => {
            state.networks.networks.zcash.backend = backend;
            state.networks.networks.zcash.backendDetected = true;
          });
        }
        if ((await local.get('zcashBackend')) !== backend) {
          await local.set('zcashBackend', backend);
        }
      },

      redetectZcashBackend: async (serverUrl: string) => {
        const backend = await redetect(serverUrl);
        if (backend) {
          await get().networks.noteZcashBackend(serverUrl, backend);
        }
      },

      setMemoSyncStrategy: async (id: NetworkId, strategy: MemoSyncStrategy) => {
        set(state => {
          state.networks.networks[id].memoSyncStrategy = strategy;
        });
        const current = (await local.get('memoSyncStrategies')) || {};
        await local.set('memoSyncStrategies', {
          ...current,
          [id]: strategy,
        });
      },

      setMempoolWatch: async (id: NetworkId, setting: MempoolWatchSetting) => {
        if (setting !== 'off' && setting !== 'on') {
          throw new Error(`invalid mempool-watch setting: ${String(setting)}`);
        }
        // the choice is kept as made; isMempoolWatchEnabled decides per backend
        set(state => {
          state.networks.networks[id].mempoolWatch = setting;
        });
        const current = (await local.get('mempoolWatchSettings')) || {};
        await local.set('mempoolWatchSettings', {
          ...current,
          [id]: setting,
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

/** the zcash node's kind: its own answer, or the guess that stands until it answers */
export const selectZcashBackend = (state: AllSlices): ZcashBackend => {
  const zcash = state.networks.networks.zcash;
  return zcash.backend ?? backendOfEndpoint(zcash.endpoint ?? '');
};

/** one re-ask per node per cooldown, shared by every caller in this context */
const redetect = createRedetector();
export const enabledNetworksSelector = (state: AllSlices) =>
  Object.values(state.networks.networks).filter(n => n.enabled);
