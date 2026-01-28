/**
 * polkadot light client - smoldot only, no rpc option
 *
 * uses smoldot embedded light client for trustless chain access.
 * connects directly to p2p network, verifies headers cryptographically.
 * no centralized rpc = no single point of metadata leakage.
 */

import { createClient } from 'polkadot-api';
import { bytesToHex } from '../common/qr';
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

/** get all ecosystem parachains (for unified UX) */
export function getEcosystemParachains(relay: RelayChain): SupportedChain[] {
  return (Object.entries(CHAIN_INFO) as [SupportedChain, ChainInfo][])
    .filter(([, info]) => info.relay === relay)
    .map(([chain]) => chain);
}

/**
 * polkadot unified addresses - same public key works on ALL parachains
 *
 * the ss58 prefix is just for display/encoding:
 * - prefix 0 = polkadot format (works everywhere in polkadot ecosystem)
 * - prefix 2 = kusama format (works everywhere in kusama ecosystem)
 * - chain-specific prefixes (63 for hydration, etc.) are optional display formats
 *
 * the underlying 32-byte public key is the SAME account across all chains.
 * so you can query hydration balance with your polkadot address.
 */

/** detect relay chain from ss58 address prefix */
export function detectRelayFromAddress(address: string): RelayChain | null {
  try {
    // simple base58 decode to extract prefix byte
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt(0);
    for (const char of address) {
      const idx = ALPHABET.indexOf(char);
      if (idx === -1) return null;
      num = num * 58n + BigInt(idx);
    }
    // extract prefix from first bytes
    const bytes = [];
    while (num > 0) {
      bytes.unshift(Number(num % 256n));
      num = num / 256n;
    }
    // ss58 prefix is in first 1-2 bytes
    const prefix = bytes[0]! < 64 ? bytes[0] : ((bytes[0]! & 0x3f) << 2) | (bytes[1]! >> 6);

    // check which relay ecosystem this belongs to
    // polkadot: prefix 0 or any polkadot parachain prefix
    // kusama: prefix 2 or any kusama parachain prefix
    for (const [chain, info] of Object.entries(CHAIN_INFO) as [SupportedChain, ChainInfo][]) {
      if (info.ss58Prefix === prefix) {
        return info.relay || (chain as RelayChain);
      }
    }

    // default: polkadot (prefix 0 is generic substrate)
    if (prefix === 0 || prefix === 42) return 'polkadot';
    if (prefix === 2) return 'kusama';

    return null;
  } catch {
    return null;
  }
}

/** detect specific chain from ss58 address prefix (for display purposes) */
export function detectChainFromAddress(address: string): SupportedChain | null {
  try {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt(0);
    for (const char of address) {
      const idx = ALPHABET.indexOf(char);
      if (idx === -1) return null;
      num = num * 58n + BigInt(idx);
    }
    const bytes = [];
    while (num > 0) {
      bytes.unshift(Number(num % 256n));
      num = num / 256n;
    }
    const prefix = bytes[0]! < 64 ? bytes[0] : ((bytes[0]! & 0x3f) << 2) | (bytes[1]! >> 6);

    for (const [chain, info] of Object.entries(CHAIN_INFO) as [SupportedChain, ChainInfo][]) {
      if (info.ss58Prefix === prefix) {
        return chain;
      }
    }
    // generic substrate address (prefix 42) or polkadot (0) -> polkadot
    if (prefix === 0 || prefix === 42) return 'polkadot';
    if (prefix === 2) return 'kusama';

    return null;
  } catch {
    return null;
  }
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

/** custom chainspecs registered by user (from storage) */
const customChainSpecs: Map<string, {
  chainspec: string;
  relay: RelayChain | 'standalone';
  name: string;
  symbol?: string;
  decimals?: number;
}> = new Map();

/**
 * register a custom chainspec from user upload
 *
 * allows connecting to any substrate chain by providing its chainspec JSON.
 * for parachains, specify the relay chain to connect through.
 */
export function registerCustomChainspec(
  id: string,
  chainspec: string,
  relay: RelayChain | 'standalone',
  name: string,
  symbol?: string,
  decimals?: number
): void {
  customChainSpecs.set(id, { chainspec, relay, name, symbol, decimals });
  // also cache the raw chainspec
  chainSpecCache.set(id, chainspec);
  console.log(`[polkadot] registered custom chainspec: ${name} (${id})`);
}

/** unregister a custom chainspec */
export function unregisterCustomChainspec(id: string): void {
  customChainSpecs.delete(id);
  chainSpecCache.delete(id);
}

/** get all registered custom chainspecs */
export function getCustomChainspecs(): Map<string, { name: string; relay: string }> {
  const result = new Map<string, { name: string; relay: string }>();
  for (const [id, spec] of customChainSpecs) {
    result.set(id, { name: spec.name, relay: spec.relay });
  }
  return result;
}

/** check if chain is a custom chainspec */
export function isCustomChain(chain: string): boolean {
  return customChainSpecs.has(chain);
}

/** static imports for chain specs from @polkadot-api/known-chains */
const CHAINSPEC_LOADERS: Record<string, () => Promise<{ chainSpec: string }>> = {
  polkadot: () => import('@polkadot-api/known-chains/polkadot'),
  ksmcc3: () => import('@polkadot-api/known-chains/ksmcc3'),
  paseo: () => import('@polkadot-api/known-chains/paseo'),
  polkadot_asset_hub: () => import('@polkadot-api/known-chains/polkadot_asset_hub'),
  polkadot_bridge_hub: () => import('@polkadot-api/known-chains/polkadot_bridge_hub'),
  polkadot_collectives: () => import('@polkadot-api/known-chains/polkadot_collectives'),
  polkadot_coretime: () => import('@polkadot-api/known-chains/polkadot_coretime'),
  polkadot_people: () => import('@polkadot-api/known-chains/polkadot_people'),
  ksmcc3_asset_hub: () => import('@polkadot-api/known-chains/ksmcc3_asset_hub'),
  ksmcc3_bridge_hub: () => import('@polkadot-api/known-chains/ksmcc3_bridge_hub'),
  ksmcc3_coretime: () => import('@polkadot-api/known-chains/ksmcc3_coretime'),
  ksmcc3_encointer: () => import('@polkadot-api/known-chains/ksmcc3_encointer'),
  ksmcc3_people: () => import('@polkadot-api/known-chains/ksmcc3_people'),
  paseo_asset_hub: () => import('@polkadot-api/known-chains/paseo_asset_hub'),
  paseo_coretime: () => import('@polkadot-api/known-chains/paseo_coretime'),
  paseo_people: () => import('@polkadot-api/known-chains/paseo_people'),
};

/**
 * dynamically load chain spec
 *
 * supports:
 * - built-in chains (SupportedChain) from CHAINSPEC_SOURCES
 * - custom chains registered via registerCustomChainspec()
 */
async function loadChainSpec(chain: string): Promise<string> {
  // check cache first (includes custom chainspecs)
  const cached = chainSpecCache.get(chain);
  if (cached) return cached;

  // check if this is a custom chain
  const customSpec = customChainSpecs.get(chain);
  if (customSpec) {
    chainSpecCache.set(chain, customSpec.chainspec);
    return customSpec.chainspec;
  }

  // look up in built-in sources
  const source = CHAINSPEC_SOURCES[chain as SupportedChain];
  if (!source) {
    throw new Error(`unknown chain: ${chain} (not in built-in sources or custom registry)`);
  }

  let spec: string;
  if (source.type === 'module') {
    // load from @polkadot-api/known-chains using static import map
    const loader = CHAINSPEC_LOADERS[source.path];
    if (!loader) {
      throw new Error(`unknown chain spec module: ${source.path}`);
    }
    const module = await loader();
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
    const hexTx = '0x' + bytesToHex(signedTx);
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

/** custom chain light clients (keyed by custom chain id) */
const customClients: Map<string, PolkadotLightClient> = new Map();

/**
 * get light client for a custom chainspec
 *
 * custom chains must be registered via registerCustomChainspec() first.
 * returns null if chain is not registered.
 */
export function getCustomLightClient(chainId: string): PolkadotLightClient | null {
  if (!customChainSpecs.has(chainId)) {
    return null;
  }

  let client = customClients.get(chainId);
  if (!client) {
    // custom chains use a modified light client that accepts string chain ID
    client = new PolkadotLightClient(chainId as SupportedChain);
    customClients.set(chainId, client);
  }
  return client;
}

/**
 * connect to a custom chain by ID
 *
 * registers the chainspec if provided, then returns connected light client.
 */
export async function connectCustomChain(
  chainId: string,
  chainspec?: string,
  relay?: RelayChain | 'standalone',
  name?: string,
  symbol?: string,
  decimals?: number
): Promise<PolkadotLightClient> {
  // register if provided
  if (chainspec && relay && name) {
    registerCustomChainspec(chainId, chainspec, relay, name, symbol, decimals);
  }

  const client = getCustomLightClient(chainId);
  if (!client) {
    throw new Error(`custom chain ${chainId} not registered`);
  }

  await client.connect();
  return client;
}

/** cleanup all clients (for extension unload) */
export async function disconnectAll(): Promise<void> {
  // disconnect built-in chain clients
  for (const client of clients.values()) {
    await client.disconnect();
  }
  clients.clear();

  // disconnect custom chain clients
  for (const client of customClients.values()) {
    await client.disconnect();
  }
  customClients.clear();

  if (smoldotInstance) {
    smoldotInstance.terminate();
    smoldotInstance = null;
  }
}

// =============================================================================
// unified ecosystem balance (seamless multi-parachain UX)
// =============================================================================

/** asset balance on a specific chain */
export interface ChainAsset {
  chain: SupportedChain;
  chainName: string;
  symbol: string;
  decimals: number;
  balance: bigint;
}

/**
 * get aggregated balances across all parachains in an ecosystem
 *
 * this is the key for "seamless one network" UX - when user selects
 * "Polkadot", they see all their HDX, GLMR, ACA, DOT etc. in one view
 */
export async function getUnifiedBalance(
  relay: RelayChain,
  publicKey: Uint8Array,
): Promise<ChainAsset[]> {
  const parachains = getEcosystemParachains(relay);
  const results: ChainAsset[] = [];

  // fetch balances in parallel with error tolerance
  const fetchResults = await Promise.allSettled(
    parachains.map(async (chain) => {
      const info = CHAIN_INFO[chain];
      const client = getLightClient(chain);

      try {
        // connect if needed
        if (client.state.state !== 'ready') {
          await client.connect();
        }

        const balance = await client.getBalance({ publicKey } as any);

        return {
          chain,
          chainName: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          balance,
        };
      } catch (err) {
        // chain unavailable, return zero balance
        return {
          chain,
          chainName: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          balance: 0n,
        };
      }
    })
  );

  // collect successful results
  for (const result of fetchResults) {
    if (result.status === 'fulfilled' && result.value.balance > 0n) {
      results.push(result.value);
    }
  }

  // sort by balance (highest first)
  return results.sort((a, b) => Number(b.balance - a.balance));
}

/**
 * get total value in relay token (DOT/KSM)
 * approximation - assumes 1:1 for simplicity, real app would use price feeds
 */
export function getTotalInRelayToken(assets: ChainAsset[], relay: RelayChain): bigint {
  const relayInfo = CHAIN_INFO[relay];
  let total = 0n;

  for (const asset of assets) {
    if (asset.chain === relay || asset.symbol === relayInfo.symbol) {
      // native relay token - add directly
      total += asset.balance;
    }
    // for parachain tokens, would need price oracle - skip for now
  }

  return total;
}
