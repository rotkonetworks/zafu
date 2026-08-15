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
  origin: string;
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
  result:
    | { approved: true; payload?: unknown }
    | { approved: false; error?: string };
}

export const isKeplrApprovalResult = (m: unknown): m is KeplrApprovalResult =>
  typeof m === 'object' &&
  m !== null &&
  (m as { type?: unknown }).type === 'zafu_keplr_result' &&
  typeof (m as { requestId?: unknown }).requestId === 'string';

/** the request stashed in session storage for the approval popup to read */
export interface KeplrApprovalRequest {
  requestId: string;
  method: 'enable' | 'signAmino' | 'signDirect';
  origin: string;
  chainId: string;
  /** signer bech32 address (sign methods) */
  signerAddress?: string;
  /** amino StdSignDoc, or the base64 direct signDoc fields */
  signDoc?: unknown;
  favIconUrl?: string;
  title?: string;
}

export const keplrApprovalKey = (requestId: string): string => `keplrApproval:${requestId}`;
export const keplrKeyCacheKey = (origin: string, chainId: string): string =>
  `keplrKey:${origin}:${chainId}`;

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
      return id as CosmosChainId;
    }
  }
  // fall back to a prefix match (keplr chain ids are usually "<prefix>-<n>")
  const prefix = keplrChainId.split('-')[0];
  for (const [id, config] of Object.entries(COSMOS_CHAINS)) {
    if (config.bech32Prefix === prefix) {
      return id as CosmosChainId;
    }
  }
  return undefined;
};
