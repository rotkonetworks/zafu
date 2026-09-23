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

export type CosmosChainId = 'noble' | 'cosmoshub' | 'injective' | 'osmosis';

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
    // Interchangeable public Noble RPCs - rotated per address for privacy.
    // Only verified-reachable hosts ship as defaults; users can add their own
    // in Settings -> networks -> Penumbra -> Noble. (cosmos.directory is itself
    // a load-balancing proxy, so it adds provider diversity on its own.)
    rpcEndpoints: ['https://noble-rpc.polkachu.com', 'https://rpc.cosmos.directory/noble'],
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
    restEndpoint: 'https://cosmos-api.polkachu.com',
    gasPrice: '0.025uatom',
    penumbraChannel: 'channel-940', // cosmoshub -> penumbra
    penumbraSourceChannel: 'channel-0', // penumbra -> cosmoshub
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
    restEndpoint: 'https://sentry.lcd.injective.network',
    gasPrice: '160000000inj', // INJ, 18 dec
    // Ethermint: coin type 60 / eth_secp256k1 - derive+sign via networks/injective,
    // NEVER the shared cosmos secp256k1 path (guarded in deriveChainAddress).
    keyAlgo: 'eth_secp256k1',
    coinType: 60,
    gasAsset: { symbol: 'INJ', denom: 'inj', decimals: 18 },
    // Live channel (opened 2026-09-16, verified on-chain 2026-09-17: injective
    // channel-494 STATE_OPEN, client 07-tendermint-353 Active, tracks penumbra-1).
    // The old 15/434 path is dead and must NOT be used.
    penumbraChannel: 'channel-494', // injective -> penumbra (shieldInToPenumbra sourceChannel)
    penumbraSourceChannel: 'channel-18', // penumbra -> injective
    // NOTE: launched stays false in the extension until the testnet round-trip
    // (inj-testnet-roundtrip.mts) returns code:0 - the channel unblocks shield-in
    // wiring/testing but the enable gate is still the funded-testnet pass.
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
    restEndpoint: 'https://osmosis-api.polkachu.com',
    gasPrice: '0.025uosmo',
    // standard cosmos: secp256k1, coin type 118 (keyAlgo/coinType left default),
    // so the shared cosmos adapter + coin-118 deriveChainAddress path handle it.
    // penumbraChannel intentionally UNSET: both declared Osmosis<->Penumbra
    // channels (4/79703 and 17/110473) have Expired penumbra clients - dead until
    // re-relayed. Keep launched:false until one is live.
  },
};

/** get chain config by id */
export function getCosmosChain(id: CosmosChainId): CosmosChainConfig {
  return COSMOS_CHAINS[id];
}

/** the RPC pool for a chain (falls back to the single primary endpoint) */
export function rpcEndpointPool(id: CosmosChainId): string[] {
  const config = COSMOS_CHAINS[id];
  return config.rpcEndpoints?.length ? config.rpcEndpoints : [config.rpcEndpoint];
}

/**
 * Pick an RPC endpoint for a given burner index, rotating through the pool so
 * consecutive burners hit different providers. Deterministic per index so the
 * same burner always maps to the same endpoint within a session.
 */
export function rpcEndpointForIndex(id: CosmosChainId, index: number): string {
  const pool = rpcEndpointPool(id);
  return pool[index % pool.length] ?? COSMOS_CHAINS[id].rpcEndpoint;
}

/** get all chain ids */
export function getAllCosmosChainIds(): CosmosChainId[] {
  return Object.keys(COSMOS_CHAINS) as CosmosChainId[];
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
