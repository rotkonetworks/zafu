/**
 * The transparent cosmos chains Penumbra connects to.
 *
 * Every chain in the penumbrafi registry with a `transparent` block is here
 * (see registry-chains.ts), so a new connection needs a registry release,
 * not a zafu one. The entries written out below are presets that win over the
 * registry: Injective, whose Ethermint keys the registry leaves out, and the
 * chains whose curated node pools or wind-down notices predate it. Which of
 * them is offered at any moment is decided by the user's Penumbra node
 * (transparent/penumbra-routes), never by this list.
 */

import { fromBech32 } from '@cosmjs/encoding';

import { ChainRegistryClient, type Chain } from '@penumbrafi/registry';
import { chainsFromRegistry } from './registry-chains';

/** a chain-registry chain name, e.g. 'osmosis' */
export type CosmosChainId = string;

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
  /** RPC endpoint (primary / default) */
  rpcEndpoint: string;
  /**
   * Pool of interchangeable RPC endpoints. Burner scans rotate through these so
   * no single RPC provider sees every one of your deposit addresses together -
   * ideally each burner is queried from a different endpoint. Falls back to
   * `rpcEndpoint` when unset.
   */
  rpcEndpoints?: string[];
  /** REST/LCD endpoint */
  restEndpoint: string;
  /** gas price in native denom */
  gasPrice: string;
  /** IBC channel on the cosmos chain pointing to penumbra */
  penumbraChannel?: string;
  /** IBC channel on penumbra pointing to this chain (for IBC withdrawals) */
  penumbraSourceChannel?: string;
  /**
   * Set when the chain (or its only supported asset) is being wound down, so
   * the UI can warn holders to move funds out before they are stranded. Dates
   * are ISO (YYYY-MM-DD).
   */
  deprecation?: {
    /** one-line reason, e.g. who is deprecating what */
    reason: string;
    /** date the usual way out (bridge) stops working - move funds by here */
    moveOutBy: string;
    /** date assets are effectively frozen on-chain (hard cutoff) */
    frozenBy: string;
    /** what the holder should do */
    guidance: string;
  };
  /**
   * Key algorithm for derivation/signing. Undefined = standard cosmos:
   * secp256k1, coin type 118, ripemd160(sha256(pubkey)) address. 'eth_secp256k1'
   * marks an Ethermint chain (Injective): coin type 60, keccak256 address,
   * keccak-digest signatures - which the shared cosmos signer/prefix-swap MUST
   * NOT handle (see networks/injective). Guarded in deriveChainAddress.
   */
  keyAlgo?: 'secp256k1' | 'eth_secp256k1';
  /** BIP44 coin type; defaults to 118 (cosmos). Injective is 60. */
  coinType?: number;
  /**
   * Fee/gas token when it differs from the ramp asset (`symbol`/`denom`/
   * `decimals`). On Injective the ramp asset is USDC but gas is paid in INJ
   * (18 dec), so a fresh burner that only holds USDC cannot move it - the UI
   * must surface this. Undefined = gas is paid in the chain's own `denom`.
   */
  gasAsset?: { symbol: string; denom: string; decimals: number };
  /**
   * x/feegrant sponsor (apps/feegrant) that pays gas for holders of a supported
   * stablecoin who have none of the gas asset. Contacted only when needed.
   */
  gasSponsorUrl?: string;
}

const PRESETS: Record<CosmosChainId, CosmosChainConfig> = {
  noble: {
    id: 'noble',
    name: 'Noble',
    chainId: 'noble-1',
    bech32Prefix: 'noble',
    symbol: 'USDC',
    denom: 'uusdc',
    decimals: 6,
    rpcEndpoint: 'https://noble-rpc.polkachu.com',
    // Interchangeable public Noble RPCs - rotated per address for privacy.
    // Only verified-reachable hosts ship as defaults; users can add their own
    // in Settings -> networks -> Penumbra -> Noble. (cosmos.directory is itself
    // a load-balancing proxy, so it adds provider diversity on its own.) The
    // keplr.app host is the one Keplr's chain registry lists for this chain.
    rpcEndpoints: [
      'https://noble-rpc.polkachu.com',
      'https://rpc.cosmos.directory/noble',
      'https://rpc-noble.keplr.app',
    ],
    restEndpoint: 'https://noble-api.polkachu.com',
    gasPrice: '0.1uusdc',
    penumbraChannel: 'channel-89', // noble -> penumbra
    penumbraSourceChannel: 'channel-2', // penumbra -> noble
    // Circle is winding down USDC + CCTP on Noble (announced 2026-09-10): new
    // minting stops 2026-10-13, the CCTP V1 bridge halts 2026-12-01, and the
    // Noble USDC contract pauses entirely on 2027-01-12 (manual redemption only
    // after). Noble is USDC-only here, so this deprecates our Noble support.
    deprecation: {
      reason: 'Circle is ending USDC and CCTP support on Noble.',
      moveOutBy: '2026-12-01',
      frozenBy: '2027-01-12',
      guidance:
        'Move your USDC off Noble - bridge it out and sell or hold it elsewhere - before the bridge halts on Dec 1, 2026. After the contract pauses on Jan 12, 2027, only Circle’s manual redemption portal remains.',
    },
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
    // rotated per address for privacy, all verified reachable (2026-09); the
    // keplr.app host is the one Keplr's chain registry lists for this chain
    rpcEndpoints: [
      'https://cosmos-rpc.polkachu.com',
      'https://rpc.cosmos.directory/cosmoshub',
      'https://cosmos-rpc.publicnode.com:443',
      'https://rpc-cosmoshub.keplr.app',
    ],
    restEndpoint: 'https://cosmos-api.polkachu.com',
    gasPrice: '0.025uatom',
    // The live pair (checked 2026-09-27 against penumbra.rotko.net and the Hub
    // LCD, both clients Active): penumbra channel-22 <-> hub channel-1934. The
    // pair this replaced (channel-0 <-> channel-940) is still OPEN but its
    // penumbra-side client is EXPIRED, so packets over it can't be relayed.
    // ATOM that came in over channel-0 is a different denom and can only leave
    // the way it came, once that client is revived.
    penumbraChannel: 'channel-1934', // cosmoshub -> penumbra
    penumbraSourceChannel: 'channel-22', // penumbra -> cosmoshub
  },
  injective: {
    id: 'injective',
    name: 'Injective',
    chainId: 'injective-1',
    bech32Prefix: 'inj',
    // ramp asset = Circle-native USDC on Injective (USDC.inj), NOT peggy. Gas is
    // a separate token (INJ, see gasAsset).
    symbol: 'USDC.inj',
    denom: 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a',
    decimals: 6,
    rpcEndpoint: 'https://sentry.tm.injective.network:443',
    // Interchangeable public Injective RPCs - rotated per address for privacy,
    // all verified reachable (2026-09). The keplr.app host is the one Keplr's
    // chain registry lists for this chain.
    rpcEndpoints: [
      'https://injective-rpc.publicnode.com:443',
      'https://rpc.cosmos.directory/injective',
      'https://sentry.tm.injective.network:443',
      'https://rpc-injective.keplr.app',
    ],
    restEndpoint: 'https://sentry.lcd.injective.network',
    gasPrice: '160000000inj', // INJ, 18 dec
    // Ethermint: coin type 60 / eth_secp256k1 - derive+sign via networks/injective,
    // NEVER the shared cosmos secp256k1 path (guarded in deriveChainAddress).
    keyAlgo: 'eth_secp256k1',
    coinType: 60,
    gasAsset: { symbol: 'INJ', denom: 'inj', decimals: 18 },
    gasSponsorUrl: 'https://sponsor.zafu.pro',
    // Live channel (opened 2026-09-16, verified on-chain 2026-09-17: injective
    // channel-494 STATE_OPEN, client 07-tendermint-353 Active, tracks penumbra-1).
    // The old 15/434 path is dead and must NOT be used.
    penumbraChannel: 'channel-494', // injective -> penumbra (shieldInToPenumbra sourceChannel)
    penumbraSourceChannel: 'channel-18', // penumbra -> injective
    // NETWORKS.injective.launched is true: the signer is proven on mainnet
    // (round-trip tx 5699D4FC..., code 0) and the channel above is live, so the
    // earlier funded-testnet enable gate is satisfied.
  },
  osmosis: {
    id: 'osmosis',
    name: 'Osmosis',
    chainId: 'osmosis-1',
    bech32Prefix: 'osmo',
    symbol: 'OSMO',
    denom: 'uosmo',
    decimals: 6,
    rpcEndpoint: 'https://osmosis-rpc.polkachu.com',
    // rotated per address for privacy, all verified reachable (2026-09); the
    // keplr.app host is the one Keplr's chain registry lists for this chain
    rpcEndpoints: [
      'https://osmosis-rpc.polkachu.com',
      'https://rpc.cosmos.directory/osmosis',
      'https://osmosis-rpc.publicnode.com:443',
      'https://rpc-osmosis.keplr.app',
    ],
    restEndpoint: 'https://osmosis-api.polkachu.com',
    gasPrice: '0.025uosmo',
    // standard cosmos: secp256k1, coin type 118 (keyAlgo/coinType left default),
    // so the shared cosmos adapter + coin-118 deriveChainAddress path handle it.
    // Live pair (checked 2026-09-27, both clients Active): penumbra channel-20
    // <-> osmosis channel-111093. channel-19 <-> 111092 is also live on the same
    // connection, but the penumbra registry (penumbrafi 13.2.0) labels osmosis
    // assets on channel-20, and a token's penumbra denom embeds its channel, so
    // this pin must match it; route discovery keeps a live pin. The old pairs
    // (4/79703, 17/110473) have expired penumbra clients.
    penumbraChannel: 'channel-111093', // osmosis -> penumbra
    penumbraSourceChannel: 'channel-20', // penumbra -> osmosis
  },
};

const registryConnections = () => {
  try {
    return new ChainRegistryClient().bundled.get('penumbra-1').ibcConnections;
  } catch {
    return [];
  }
};

export const COSMOS_CHAINS: Record<CosmosChainId, CosmosChainConfig> = {
  ...chainsFromRegistry(registryConnections()),
  ...PRESETS,
};

type ChainsListener = (added: CosmosChainId[]) => void;
const listeners = new Set<ChainsListener>();

/**
 * Tables built from COSMOS_CHAINS when their module loads (networks, egress
 * rows) register here, and are told which chains a verified live registry
 * added. Returns the unsubscribe.
 */
export function onCosmosChainsAdded(listener: ChainsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Adds the chains of a verified live copy of the registry that zafu does not
 * know yet, in place (every holder of COSMOS_CHAINS sees them). A chain zafu
 * already knows - a preset, a bundled one, or one an earlier live copy added
 * this session - is never touched: the live copy exists for chains zafu
 * doesn't know, and a channel pin decides where funds go, so one compromised
 * registry key must not be able to re-pin the chains users already rely on.
 * Returns the chains it added.
 */
export function applyLiveConnections(connections: readonly Chain[]): CosmosChainId[] {
  const live = chainsFromRegistry(connections);
  const added: CosmosChainId[] = [];
  for (const [id, config] of Object.entries(live)) {
    if (id in COSMOS_CHAINS) {
      continue;
    }
    added.push(id);
    COSMOS_CHAINS[id] = config;
  }
  if (added.length) {
    for (const l of listeners) {
      l(added);
    }
  }
  return added;
}

/** a known chain's config; an id from outside COSMOS_CHAINS is a bug, so it throws */
export function getCosmosChain(id: CosmosChainId): CosmosChainConfig {
  const config = COSMOS_CHAINS[id];
  if (!config) {
    throw new Error(`unknown cosmos chain: ${id}`);
  }
  return config;
}

/** the RPC pool for a chain (falls back to the single primary endpoint) */
export function rpcEndpointPool(id: CosmosChainId): string[] {
  const config = getCosmosChain(id);
  return config.rpcEndpoints?.length ? config.rpcEndpoints : [config.rpcEndpoint];
}

/**
 * Pick an RPC endpoint for a given burner index, rotating through the pool so
 * consecutive burners hit different providers. Deterministic per index so the
 * same burner always maps to the same endpoint within a session.
 */
export function rpcEndpointForIndex(id: CosmosChainId, index: number): string {
  const pool = rpcEndpointPool(id);
  return pool[index % pool.length] ?? getCosmosChain(id).rpcEndpoint;
}

/** get all chain ids */
export function getAllCosmosChainIds(): CosmosChainId[] {
  return Object.keys(COSMOS_CHAINS);
}

/** validate bech32 address for any supported chain */
export function isValidCosmosAddress(address: string): boolean {
  return Object.values(COSMOS_CHAINS).some(chain => address.startsWith(`${chain.bech32Prefix}1`));
}

/** get chain from address prefix */
export function getChainFromAddress(address: string): CosmosChainConfig | undefined {
  return Object.values(COSMOS_CHAINS).find(chain => address.startsWith(`${chain.bech32Prefix}1`));
}

/**
 * Canonical lookup by the cosmos chain id (e.g. "injective-1", "noble-1").
 *
 * This is the single source of truth callers should use instead of the ad-hoc,
 * mutually-inconsistent maps that grew around the receive/send flows (a
 * hardcoded 3-entry registry->CosmosChainId map, a broken `prefix in
 * COSMOS_CHAINS` test, and a `['noble']` allow-list) - those disagreed about
 * which chains exist and were the root of the "Noble only" symptom. Rewiring
 * those call sites onto this lookup is a follow-up that touches which chain a
 * signer runs against, so it is done under review, not here.
 */
export function chainByChainId(chainId: string): CosmosChainConfig | undefined {
  return Object.values(COSMOS_CHAINS).find(chain => chain.chainId === chainId);
}

/** Canonical lookup by bare bech32 prefix (e.g. "inj", "noble"). */
export function chainByPrefix(prefix: string): CosmosChainConfig | undefined {
  return Object.values(COSMOS_CHAINS).find(chain => chain.bech32Prefix === prefix);
}

/**
 * Full bech32 validation (checksum + structure) against an expected prefix -
 * NOT a prefix-only `startsWith`. Use this to validate an irreversible unshield
 * / withdraw destination: a corrupted `inj1.../noble1...` address passes a
 * prefix check but fails the checksum here, so funds are never sent to a typo.
 */
export function isValidBech32(address: string, prefix: string): boolean {
  try {
    return fromBech32(address).prefix === prefix;
  } catch {
    return false;
  }
}
