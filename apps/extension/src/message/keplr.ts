/**
 * Wire contract for the Keplr-compatible provider, shared by the service-worker
 * handler (message/listen/keplr.ts) and the approval screen
 * (routes/popup/approval/keplr.tsx).
 *
 * Binary crosses the content-script boundary base64-encoded (see
 * injected-keplr.ts), so every field here is JSON-safe.
 */

import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

/** message the content-script bridge sends to the service worker */
export interface KeplrMessage {
  type: 'ZafuKeplr';
  method: string;
  params: unknown;
}

export const isKeplrMessage = (m: unknown): m is KeplrMessage =>
  typeof m === 'object' &&
  m !== null &&
  (m as { type?: unknown }).type === 'ZafuKeplr' &&
  typeof (m as { method?: unknown }).method === 'string';

/** result posted back from the approval popup to the service worker */
export interface KeplrApprovalResult {
  type: 'zafu_keplr_result';
  requestId: string;
  result: { approved: true; payload?: unknown } | { approved: false; error?: string };
}

export const isKeplrApprovalResult = (m: unknown): m is KeplrApprovalResult =>
  typeof m === 'object' &&
  m !== null &&
  (m as { type?: unknown }).type === 'zafu_keplr_result' &&
  typeof (m as { requestId?: unknown }).requestId === 'string';

/** the request stashed in session storage for the approval popup to read */
export interface KeplrApprovalRequest {
  requestId: string;
  method: 'enable' | 'signAmino' | 'signDirect' | 'signArbitrary';
  origin: string;
  chainId: string;
  /** signer bech32 address (sign methods) */
  signerAddress?: string;
  /** amino StdSignDoc (an ADR-036 one for signArbitrary), or the base64 direct signDoc fields */
  signDoc?: unknown;
  favIconUrl?: string;
  title?: string;
  /** enable: account prefixes the site suggested, only for chains zafu doesn't know */
  prefixes?: Record<string, string>;
}

/** the chain id a sign doc commits to: amino `chain_id`, direct `chainId` */
export const signedChainId = (
  method: 'signAmino' | 'signDirect',
  doc: unknown,
): string | undefined => {
  if (typeof doc !== 'object' || doc === null) {
    return undefined;
  }
  const id = (doc as Record<string, unknown>)[method === 'signAmino' ? 'chain_id' : 'chainId'];
  return typeof id === 'string' ? id : undefined;
};

export const keplrApprovalKey = (requestId: string): string => `keplrApproval:${requestId}`;
export const keplrKeyCacheKey = (origin: string, chainId: string): string =>
  `keplrKey:${origin}:${chainId}`;
export const keplrSuggestedKey = (origin: string, chainId: string): string =>
  `keplrSuggested:${origin}:${chainId}`;

/**
 * The account prefix an experimentalSuggestChain payload names, when zafu can
 * give that chain a key: only ever for a chain id zafu doesn't know (a
 * built-in chain keeps its own prefix). The suggestion comes from the site, so
 * it is refused when zafu's key would be the wrong one for it:
 * - a coin type other than 118, or an Ethermint chain (eth key features):
 *   zafu derives a cosmos secp256k1 key, and an address from it on such a
 *   chain would look right but could not move what is sent there;
 * - a prefix a built-in chain uses (`inj`, `osmo`, ...): it would show a
 *   familiar-looking address from the wrong key;
 * - a prefix too long for a 20-byte address within bech32's 90 characters.
 */
export const suggestedPrefix = (chainInfo: unknown): string | undefined => {
  const info = chainInfo as
    | {
        bech32Config?: { bech32PrefixAccAddr?: unknown };
        bip44?: { coinType?: unknown };
        features?: unknown;
      }
    | undefined;
  const prefix = info?.bech32Config?.bech32PrefixAccAddr;
  const coinType = info?.bip44?.coinType ?? 118;
  const features = Array.isArray(info?.features) ? info.features : [];
  const ethKeys = features.some(f => typeof f === 'string' && f.startsWith('eth-'));
  const builtIn = Object.values(COSMOS_CHAINS).some(c => c.bech32Prefix === prefix);
  return typeof prefix === 'string' &&
    /^[a-z][a-z0-9]{0,50}$/.test(prefix) &&
    coinType === 118 &&
    !ethKeys &&
    !builtIn
    ? prefix
    : undefined;
};

/** the cached, derived key for one origin+chain (base64 binary) */
export interface KeplrWireKey {
  name: string;
  algo: string;
  pubKeyB64: string;
  addressB64: string;
  bech32Address: string;
}

/**
 * Resolve our internal CosmosChainId from a Keplr chain id (e.g. "noble-1").
 * Matches on the configured chainId first, then the bech32 prefix, so both
 * "noble-1" and a "noble1..."-derived hint resolve.
 */
export const cosmosChainIdFromKeplr = (keplrChainId: string): CosmosChainId | undefined => {
  for (const [id, config] of Object.entries(COSMOS_CHAINS)) {
    if (config.chainId === keplrChainId) {
      return id;
    }
  }
  // fall back to a prefix match (keplr chain ids are usually "<prefix>-<n>")
  const prefix = keplrChainId.split('-')[0];
  for (const [id, config] of Object.entries(COSMOS_CHAINS)) {
    if (config.bech32Prefix === prefix) {
      return id;
    }
  }
  return undefined;
};
