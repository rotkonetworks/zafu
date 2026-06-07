import { AllSlices, SliceCreator } from '.';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import { isZidecarEndpoint, type ZcashBackend } from './keyring/zcash-backend';

/**
 * Supported network ecosystems.
 *
 * Privacy networks (zcash, penumbra): require trusted sync endpoint
 * IBC chains (noble, cosmoshub): cosmos-sdk chains for IBC transfers
 * Transparent networks (polkadot, ethereum): simple RPC balance queries
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
  | 'polkadot'
  | 'kusama'
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
export type MemoSyncStrategy = 'private' | 'fast' | 'paranoid';

/**
 * Mempool-watch toggle. Off by default (per the hdevalence review): the
 * feature has a real privacy cost — the indexer learns the wallet is online
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
   * Mempool watch toggle for shielded networks. Off by default — opening
   * a polling subscription reveals to the indexer that this wallet is
   * online and continuously interested in mempool state. See README.
   * Honored only when backend === 'zidecar' (lightwalletd has no
   * compact-mempool RPC); UI must hide/disable the toggle otherwise.
   */
  mempoolWatch?: MempoolWatchSetting;
  /**
   * Sync backend. NOT auto-detected — declarative per endpoint. Probes
   * leak "this is a zafu client" and are deliberately avoided.
   *   'zidecar'      — trustless verification pipeline (Ligerito + NOMT)
   *   'lightwalletd' — trusted public indexer (no verification)
   */
  backend?: ZcashBackend;
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
  /** Manually override the Zcash sync backend (advanced settings). */
  setZcashBackend: (backend: ZcashBackend) => Promise<void>;
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
    syncDescription: 'Compact blocks verified by state commitment tree. Trial-decrypted locally — keys never leave this device.',
    bech32Prefix: 'penumbra',
  },
  zcash: {
    id: 'zcash',
    name: 'Zcash',
    symbol: 'ZEC',
    decimals: 8,
    enabled: false,
    endpoint: 'https://zcash.rotko.net',
    syncDescription: 'Zidecar trustless sync — header chain proven via Ligerito polynomial commitments, nullifier set verified by NOMT merkle proofs. Compact blocks are trial-decrypted locally — keys never leave this device.',
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
      const memoSyncStrategies = await local.get('memoSyncStrategies');
      const mempoolWatchSettings = await local.get('mempoolWatchSettings');
      const zcashBackend = await local.get('zcashBackend');

      if (enabledNetworks || networkEndpoints || memoSyncStrategies || mempoolWatchSettings || zcashBackend) {
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
          // Apply persisted Zcash backend (defensive: only known enum values).
          if (zcashBackend === 'zidecar' || zcashBackend === 'lightwalletd') {
            state.networks.networks.zcash.backend = zcashBackend;
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

        // Declaratively classify the new Zcash endpoint. We deliberately
        // do NOT probe a zidecar-only RPC here — every other Zcash light
        // wallet that talks to public lightwalletd never hits those paths,
        // so a probe uniquely fingerprints "this is a zafu client." Match
        // a static known-zidecar list instead; users on custom endpoints
        // can override via the backend picker.
        if (id === 'zcash') {
          const backend: ZcashBackend = isZidecarEndpoint(endpoint) ? 'zidecar' : 'lightwalletd';
          set(state => {
            state.networks.networks.zcash.backend = backend;
            // Force-off mempool watch when moving to lightwalletd — the
            // worker also enforces this, but flipping state here keeps
            // the UI and any consumers consistent immediately.
            if (backend === 'lightwalletd') {
              state.networks.networks.zcash.mempoolWatch = 'off';
            }
          });
          await local.set('zcashBackend', backend);
        }
      },

      setZcashBackend: async (backend: ZcashBackend) => {
        // explicit override path (advanced settings). same invariant as
        // setNetworkEndpoint: lightwalletd ⇒ mempool watch off.
        if (backend !== 'zidecar' && backend !== 'lightwalletd') {
          throw new Error(`invalid zcash backend: ${String(backend)}`);
        }
        set(state => {
          state.networks.networks.zcash.backend = backend;
          if (backend === 'lightwalletd') {
            state.networks.networks.zcash.mempoolWatch = 'off';
          }
        });
        await local.set('zcashBackend', backend);
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
        // Enforce: mempool watch only makes sense on the zidecar backend.
        // If the caller asks for 'on' but the network is on lightwalletd,
        // silently coerce to 'off' — the worker won't run a watcher anyway,
        // and we keep persisted state consistent with worker behavior.
        const cfg = get().networks.networks[id];
        const effective: MempoolWatchSetting =
          setting === 'on' && cfg?.backend === 'lightwalletd' ? 'off' : setting;
        set(state => {
          state.networks.networks[id].mempoolWatch = effective;
        });
        const current = (await local.get('mempoolWatchSettings')) || {};
        await local.set('mempoolWatchSettings', {
          ...current,
          [id]: effective,
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
