/**
 * polkadot light client - smoldot only, no rpc option
 *
 * uses smoldot embedded light client for trustless chain access.
 * connects directly to p2p network, verifies headers cryptographically.
 * no centralized rpc = no single point of metadata leakage.
 */

import { createClient } from 'polkadot-api';
import { getSmProvider } from 'polkadot-api/sm-provider';
import { start } from 'polkadot-api/smoldot';
import type { PolkadotNetworkKeys } from '../common/types';

// =============================================================================
// user-facing networks (what user sees in UI)
// =============================================================================

/** networks shown to user - simple, no parachain complexity */
export type PolkadotNetwork = 'polkadot' | 'kusama' | 'paseo';

export interface NetworkConfig {
  name: string;
  decimals: number;
  symbol: string;
  /** default chain for transfers (asset hub) */
  defaultChain: SupportedChain;
  /** relay chain for session keys / validator ops */
  relayChain: RelayChain;
}

export const POLKADOT_NETWORKS: Record<PolkadotNetwork, NetworkConfig> = {
  polkadot: {
    name: 'Polkadot',
    decimals: 10,
    symbol: 'DOT',
    defaultChain: 'polkadot_asset_hub',
    relayChain: 'polkadot',
  },
  kusama: {
    name: 'Kusama',
    decimals: 12,
    symbol: 'KSM',
    defaultChain: 'ksmcc3_asset_hub',
    relayChain: 'kusama',
  },
  paseo: {
    name: 'Paseo',
    decimals: 10,
    symbol: 'PAS',
    defaultChain: 'paseo_asset_hub',
    relayChain: 'paseo',
  },
};

// =============================================================================
// internal chain types (handled under the hood)
// =============================================================================

/** relay chains */
export type RelayChain = 'polkadot' | 'kusama' | 'paseo';

/** system parachains (in @polkadot-api/known-chains) */
export type SystemParachain =
  | 'polkadot_asset_hub'
  | 'polkadot_bridge_hub'
  | 'polkadot_collectives'
  | 'polkadot_coretime'
  | 'polkadot_people'
  | 'ksmcc3_asset_hub'
  | 'ksmcc3_bridge_hub'
  | 'ksmcc3_coretime'
  | 'ksmcc3_encointer'
  | 'ksmcc3_people'
  | 'paseo_asset_hub'
  | 'paseo_coretime'
  | 'paseo_people';

/** ecosystem parachains (chain specs fetched at runtime) */
export type EcosystemParachain =
  | 'hydration'      // hydradx - defi/liquidity
  | 'moonbeam'       // evm compatible
  | 'moonriver'      // kusama evm
  | 'bifrost'        // liquid staking
  | 'acala'          // defi hub
  | 'astar'          // smart contracts
  | 'phala'          // confidential computing
  | 'centrifuge';    // real world assets

/** all supported chains (internal use) */
export type SupportedChain = RelayChain | SystemParachain | EcosystemParachain;

/** get parent network for a chain (what user sees) */
export function getParentNetwork(chain: SupportedChain): PolkadotNetwork {
  const info = CHAIN_INFO[chain];
  return info.relay ?? (chain as PolkadotNetwork);
}

/** chain display info */
export interface ChainInfo {
  name: string;
  relay?: RelayChain;
  decimals: number;
  symbol: string;
  ss58Prefix: number;
}

export const CHAIN_INFO: Record<SupportedChain, ChainInfo> = {
  // relay chains (validators only - session keys)
  polkadot: { name: 'Relay Chain', decimals: 10, symbol: 'DOT', ss58Prefix: 0 },
  kusama: { name: 'Relay Chain', decimals: 12, symbol: 'KSM', ss58Prefix: 2 },
  paseo: { name: 'Relay Chain', decimals: 10, symbol: 'PAS', ss58Prefix: 0 },

  // polkadot system parachains
  polkadot_asset_hub: { name: 'Asset Hub', relay: 'polkadot', decimals: 10, symbol: 'DOT', ss58Prefix: 0 },
  polkadot_bridge_hub: { name: 'Bridge Hub', relay: 'polkadot', decimals: 10, symbol: 'DOT', ss58Prefix: 0 },
  polkadot_collectives: { name: 'Collectives', relay: 'polkadot', decimals: 10, symbol: 'DOT', ss58Prefix: 0 },
  polkadot_coretime: { name: 'Coretime', relay: 'polkadot', decimals: 10, symbol: 'DOT', ss58Prefix: 0 },
  polkadot_people: { name: 'People', relay: 'polkadot', decimals: 10, symbol: 'DOT', ss58Prefix: 0 },

  // kusama system parachains (ksmcc3 = kusama)
  ksmcc3_asset_hub: { name: 'Asset Hub', relay: 'kusama', decimals: 12, symbol: 'KSM', ss58Prefix: 2 },
  ksmcc3_bridge_hub: { name: 'Bridge Hub', relay: 'kusama', decimals: 12, symbol: 'KSM', ss58Prefix: 2 },
  ksmcc3_coretime: { name: 'Coretime', relay: 'kusama', decimals: 12, symbol: 'KSM', ss58Prefix: 2 },
  ksmcc3_encointer: { name: 'Encointer', relay: 'kusama', decimals: 12, symbol: 'KSM', ss58Prefix: 2 },
  ksmcc3_people: { name: 'People', relay: 'kusama', decimals: 12, symbol: 'KSM', ss58Prefix: 2 },

  // paseo system parachains (testnet)
  paseo_asset_hub: { name: 'Asset Hub', relay: 'paseo', decimals: 10, symbol: 'PAS', ss58Prefix: 0 },
  paseo_coretime: { name: 'Coretime', relay: 'paseo', decimals: 10, symbol: 'PAS', ss58Prefix: 0 },
  paseo_people: { name: 'People', relay: 'paseo', decimals: 10, symbol: 'PAS', ss58Prefix: 0 },

  // polkadot ecosystem parachains
  hydration: { name: 'Hydration', relay: 'polkadot', decimals: 12, symbol: 'HDX', ss58Prefix: 63 },
  moonbeam: { name: 'Moonbeam', relay: 'polkadot', decimals: 18, symbol: 'GLMR', ss58Prefix: 1284 },
  bifrost: { name: 'Bifrost', relay: 'polkadot', decimals: 12, symbol: 'BNC', ss58Prefix: 6 },
  acala: { name: 'Acala', relay: 'polkadot', decimals: 12, symbol: 'ACA', ss58Prefix: 10 },
  astar: { name: 'Astar', relay: 'polkadot', decimals: 18, symbol: 'ASTR', ss58Prefix: 5 },
  phala: { name: 'Phala', relay: 'polkadot', decimals: 12, symbol: 'PHA', ss58Prefix: 30 },
  centrifuge: { name: 'Centrifuge', relay: 'polkadot', decimals: 18, symbol: 'CFG', ss58Prefix: 36 },

  // kusama ecosystem parachains
  moonriver: { name: 'Moonriver', relay: 'kusama', decimals: 18, symbol: 'MOVR', ss58Prefix: 1285 },
};

/** get all chains belonging to a network */
export function getChainsForNetwork(network: PolkadotNetwork): SupportedChain[] {
  return (Object.entries(CHAIN_INFO) as [SupportedChain, ChainInfo][])
    .filter(([chain, info]) => info.relay === network || chain === network)
    .map(([chain]) => chain);
}

/** get default chain for transfers */
export function getDefaultChain(network: PolkadotNetwork): SupportedChain {
  return POLKADOT_NETWORKS[network].defaultChain;
}

/** get relay chain (validators only - session keys) */
export function getRelayChain(network: PolkadotNetwork): RelayChain {
  return POLKADOT_NETWORKS[network].relayChain;
}

/** chain spec source - either polkadot-api module name or parity chainspecs url */
interface ChainSpecSource {
  type: 'module' | 'url';
  path: string;
}

const CHAINSPEC_SOURCES: Record<SupportedChain, ChainSpecSource> = {
  // relay chains (from polkadot-api)
  polkadot: { type: 'module', path: 'polkadot' },
  kusama: { type: 'module', path: 'ksmcc3' },
  paseo: { type: 'module', path: 'paseo' },

  // system parachains (from polkadot-api)
  polkadot_asset_hub: { type: 'module', path: 'polkadot_asset_hub' },
  polkadot_bridge_hub: { type: 'module', path: 'polkadot_bridge_hub' },
  polkadot_collectives: { type: 'module', path: 'polkadot_collectives' },
  polkadot_coretime: { type: 'module', path: 'polkadot_coretime' },
  polkadot_people: { type: 'module', path: 'polkadot_people' },
  ksmcc3_asset_hub: { type: 'module', path: 'ksmcc3_asset_hub' },
  ksmcc3_bridge_hub: { type: 'module', path: 'ksmcc3_bridge_hub' },
  ksmcc3_coretime: { type: 'module', path: 'ksmcc3_coretime' },
  ksmcc3_encointer: { type: 'module', path: 'ksmcc3_encointer' },
  ksmcc3_people: { type: 'module', path: 'ksmcc3_people' },
  paseo_asset_hub: { type: 'module', path: 'paseo_asset_hub' },
  paseo_coretime: { type: 'module', path: 'paseo_coretime' },
  paseo_people: { type: 'module', path: 'paseo_people' },

  // ecosystem parachains (from parity chainspecs)
  hydration: { type: 'url', path: 'https://paritytech.github.io/chainspecs/polkadot/hydradx.json' },
  moonbeam: { type: 'url', path: 'https://paritytech.github.io/chainspecs/polkadot/moonbeam.json' },
  moonriver: { type: 'url', path: 'https://paritytech.github.io/chainspecs/kusama/moonriver.json' },
  bifrost: { type: 'url', path: 'https://paritytech.github.io/chainspecs/polkadot/bifrost.json' },
  acala: { type: 'url', path: 'https://paritytech.github.io/chainspecs/polkadot/acala.json' },
  astar: { type: 'url', path: 'https://paritytech.github.io/chainspecs/polkadot/astar.json' },
  phala: { type: 'url', path: 'https://paritytech.github.io/chainspecs/polkadot/phala.json' },
  centrifuge: { type: 'url', path: 'https://paritytech.github.io/chainspecs/polkadot/centrifuge.json' },
};

/** cache for fetched chain specs */
const chainSpecCache: Map<string, string> = new Map();

/** dynamically load chain spec */
async function loadChainSpec(chain: SupportedChain): Promise<string> {
  // check cache first
  const cached = chainSpecCache.get(chain);
  if (cached) return cached;

  const source = CHAINSPEC_SOURCES[chain];

  let spec: string;
  if (source.type === 'module') {
    // load from polkadot-api/chains
    const module = await import(`polkadot-api/chains/${source.path}`);
    spec = module.chainSpec;
  } else {
    // fetch from parity chainspecs
    const response = await fetch(source.path);
    if (!response.ok) {
      throw new Error(`failed to fetch chainspec for ${chain}: ${response.status}`);
    }
    spec = await response.text();
  }

  // cache for future use
  chainSpecCache.set(chain, spec);
  return spec;
}

/** light client connection state */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'ready'
  | 'error';

export interface LightClientState {
  chain: SupportedChain;
  state: ConnectionState;
  syncedBlock: number;
  bestBlock: number;
  peers: number;
  error?: string;
}

/** smoldot instance - lazy loaded */
let smoldotInstance: ReturnType<typeof start> | null = null;

/**
 * get or create smoldot instance
 * single instance shared across all chains
 */
function getSmoldot() {
  if (!smoldotInstance) {
    smoldotInstance = start();
  }
  return smoldotInstance;
}

/**
 * polkadot light client connection
 * trustless, p2p, no rpc
 */
export class PolkadotLightClient {
  private chain: SupportedChain;
  private chainClient: Awaited<ReturnType<typeof createClient>> | null = null;
  private _state: LightClientState;
  private stateListeners: Set<(state: LightClientState) => void> = new Set();

  constructor(chain: SupportedChain = 'polkadot') {
    this.chain = chain;
    this._state = {
      chain,
      state: 'disconnected',
      syncedBlock: 0,
      bestBlock: 0,
      peers: 0,
    };
  }

  get state(): LightClientState {
    return this._state;
  }

  /** subscribe to state changes */
  onStateChange(listener: (state: LightClientState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private updateState(partial: Partial<LightClientState>) {
    this._state = { ...this._state, ...partial };
    this.stateListeners.forEach((l) => l(this._state));
  }

  /** connect to chain via light client */
  async connect(): Promise<void> {
    if (this._state.state === 'ready' || this._state.state === 'connecting') {
      return;
    }

    this.updateState({ state: 'connecting' });

    try {
      const smoldot = getSmoldot();
      const chainSpec = await loadChainSpec(this.chain);

      // for parachains, need to add relay chain first
      const info = CHAIN_INFO[this.chain];
      let relayChain;
      if (info.relay) {
        const relaySpec = await loadChainSpec(info.relay);
        relayChain = await smoldot.addChain({ chainSpec: relaySpec });
      }

      // add chain to smoldot (with relay if parachain)
      const chain = await smoldot.addChain({
        chainSpec,
        potentialRelayChains: relayChain ? [relayChain] : undefined,
      });

      // create polkadot-api client from smoldot provider
      const provider = getSmProvider(chain);
      this.chainClient = createClient(provider);

      this.updateState({ state: 'syncing' });

      // subscribe to new blocks for sync progress
      // light client syncs headers, not full blocks
      const subscription = this.chainClient.bestBlocks$.subscribe({
        next: (blocks) => {
          if (blocks.length > 0) {
            const best = blocks[0]!;
            this.updateState({
              state: 'ready',
              bestBlock: best.number,
              syncedBlock: best.number,
            });
          }
        },
        error: (err: Error) => {
          this.updateState({
            state: 'error',
            error: err.message,
          });
        },
      });

      // store unsub for cleanup
      (this as unknown as { _unsub: () => void })._unsub = () => subscription.unsubscribe();
    } catch (err) {
      this.updateState({
        state: 'error',
        error: err instanceof Error ? err.message : 'connection failed',
      });
      throw err;
    }
  }

  /** disconnect from chain */
  async disconnect(): Promise<void> {
    const unsub = (this as unknown as { _unsub?: () => void })._unsub;
    if (unsub) unsub();

    if (this.chainClient) {
      this.chainClient.destroy();
      this.chainClient = null;
    }

    this.updateState({ state: 'disconnected' });
  }

  /** get account balance */
  async getBalance(keys: PolkadotNetworkKeys): Promise<bigint> {
    if (!this.chainClient || this._state.state !== 'ready') {
      throw new Error('light client not ready');
    }

    const api = this.getApi();

    // access via bracket notation for unsafe API
    const accountInfo = await (api.query['System']!['Account'] as any).getValue(
      keys.publicKey
    );

    return accountInfo.data.free;
  }

  /** get nonce for transaction building */
  async getNonce(keys: PolkadotNetworkKeys): Promise<number> {
    if (!this.chainClient || this._state.state !== 'ready') {
      throw new Error('light client not ready');
    }

    const api = this.getApi();
    const accountInfo = await (api.query['System']!['Account'] as any).getValue(
      keys.publicKey
    );

    return accountInfo.nonce;
  }

  /** build unsigned transaction call data for zigner signing */
  async buildTransfer(
    _from: PolkadotNetworkKeys,
    to: string,
    amount: bigint
  ): Promise<Uint8Array> {
    if (!this.chainClient || this._state.state !== 'ready') {
      throw new Error('light client not ready');
    }

    const api = this.getApi();

    // create transfer call - access via bracket notation for unsafe API
    const tx = (api.tx['Balances']!['transfer_keep_alive'] as any)({
      dest: { type: 'Id', value: to },
      value: amount,
    });

    // get encoded call data (just the call, not the full extrinsic)
    const callData = tx.encodedData;

    // return as Uint8Array
    return callData.asBytes();
  }

  /** broadcast signed transaction */
  async broadcast(signedTx: Uint8Array): Promise<string> {
    if (!this.chainClient || this._state.state !== 'ready') {
      throw new Error('light client not ready');
    }

    // submit via light client
    // polkadot-api submit expects hex string and returns TxFinalizedPayload
    const hexTx = '0x' + Buffer.from(signedTx).toString('hex');
    const result = await this.chainClient.submit(hexTx);
    // return the transaction hash
    return result.txHash;
  }

  /**
   * get typed API for this chain
   *
   * note: we use getUnsafeApi() which doesn't require pre-generated descriptors.
   * this works at runtime by introspecting the metadata.
   */
  private getApi() {
    if (!this.chainClient) {
      throw new Error('chain client not initialized');
    }
    // use unsafe API which works without pre-generated descriptors
    return this.chainClient.getUnsafeApi();
  }

  /** get raw metadata bytes for merkleized proof generation */
  async getRawMetadata(): Promise<Uint8Array> {
    if (!this.chainClient || this._state.state !== 'ready') {
      throw new Error('light client not ready');
    }

    const block = await this.chainClient.getFinalizedBlock();
    return this.chainClient.getMetadata(block.hash);
  }

  /** get runtime version info (spec name, spec version) */
  async getRuntimeVersion(): Promise<{ specName: string; specVersion: number }> {
    if (!this.chainClient || this._state.state !== 'ready') {
      throw new Error('light client not ready');
    }

    const api = this.getApi();
    const version = await (api.constants['System']!['Version'] as any)();

    return {
      specName: version.spec_name,
      specVersion: version.spec_version,
    };
  }

  /** get genesis hash */
  async getGenesisHash(): Promise<string> {
    if (!this.chainClient || this._state.state !== 'ready') {
      throw new Error('light client not ready');
    }

    const specData = await this.chainClient.getChainSpecData();
    return specData.genesisHash;
  }

  /** get current chain */
  getChain(): SupportedChain {
    return this.chain;
  }
}

/** singleton clients per chain */
const clients: Map<SupportedChain, PolkadotLightClient> = new Map();

export function getLightClient(chain: SupportedChain = 'polkadot'): PolkadotLightClient {
  let client = clients.get(chain);
  if (!client) {
    client = new PolkadotLightClient(chain);
    clients.set(chain, client);
  }
  return client;
}

/** cleanup all clients (for extension unload) */
export async function disconnectAll(): Promise<void> {
  for (const client of clients.values()) {
    await client.disconnect();
  }
  clients.clear();

  if (smoldotInstance) {
    smoldotInstance.terminate();
    smoldotInstance = null;
  }
}
