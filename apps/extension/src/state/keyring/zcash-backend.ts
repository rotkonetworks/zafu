// zidecar (trustless) vs generic lightwalletd (trusted) endpoint selection.

import type {
  ChainTip,
  CompactBlock,
  CommitmentProofData,
  NullifierProofData,
  SyncStatus,
  Utxo,
} from './zidecar-client';
import { findPresetByUrl } from '../../config/zcash-endpoints';

export type ZcashBackend = 'zidecar' | 'lightwalletd';

/** Construct the right sync client for a known backend (UI-thread helper). */
export async function zcashClientFor(serverUrl: string, backend: ZcashBackend): Promise<ZcashClient> {
  // eager: also bundled into the worker, which has no `document` for chunk loading
  if (backend === 'lightwalletd') {
    const { LightwalletdClient } = await import(/* webpackMode: "eager" */ './lightwalletd-client');
    return new LightwalletdClient(serverUrl);
  }
  const { ZidecarClient } = await import(/* webpackMode: "eager" */ './zidecar-client');
  return new ZidecarClient(serverUrl);
}

/** Method surface the worker drives a backend through; ZidecarClient is a structural superset. */
export interface ZcashClient {
  getTip(): Promise<ChainTip>;
  getTreeState(height: number): Promise<{ height: number; orchardTree: string; time: number }>;
  getCompactBlocks(startHeight: number, endHeight: number): Promise<CompactBlock[]>;
  getMempoolStream(): Promise<CompactBlock[]>;
  getAddressUtxos(addresses: string[], startHeight?: number, maxEntries?: number): Promise<Utxo[]>;
  getTaddressTxids(addresses: string[], startHeight?: number): Promise<Uint8Array[]>;
  getTransaction(txid: Uint8Array): Promise<{ data: Uint8Array; height: number }>;
  getBlockTransactions(height: number): Promise<{ height: number; hash: Uint8Array; txs: Array<{ data: Uint8Array; height: number }> }>;
  getBlockTime(height: number): Promise<number>;
  sendTransaction(txData: Uint8Array): Promise<{ txid: Uint8Array; errorCode: number; errorMessage: string }>;
  // trustless-only (zidecar)
  getHeaderProof(): Promise<{ proofBytes: Uint8Array; fromHeight: number; toHeight: number }>;
  getCommitmentProofs(cmxs: Uint8Array[], positions: number[], height: number): Promise<{ proofs: CommitmentProofData[]; treeRoot: Uint8Array }>;
  getNullifierProofs(nullifiers: Uint8Array[], height: number): Promise<{ proofs: NullifierProofData[]; nullifierRoot: Uint8Array }>;
  getSyncStatus(): Promise<SyncStatus>;
}

/**
 * Declaratively classify an endpoint URL as zidecar-speaking or generic
 * lightwalletd.
 *
 * Design choice (defensive, hdevalence-style):
 *   We deliberately do NOT auto-probe a zidecar-only RPC at runtime.
 *   Probing `zidecar.v1.Zidecar/GetSyncStatus` against an arbitrary
 *   endpoint is a unique-to-zafu request signature — no other Zcash
 *   wallet hits that path. Even on failure the probe is an unambiguous
 *   "this is a zafu client" beacon that survives across IP changes,
 *   browser sessions, and TLS handshakes.
 *
 * Instead: a static known-host suffix list. Endpoints we ship default
 * to zidecar; everything else defaults to lightwalletd. Users on a
 * custom zidecar deployment can override via setZcashBackend.
 *
 * The static list is intentionally narrow. Add to it only after we've
 * shipped a zidecar at the deployment in question.
 */
const KNOWN_ZIDECAR_HOST_SUFFIXES: ReadonlyArray<string> = [
  'rotko.net',
];

export function isZidecarEndpoint(serverUrl: string): boolean {
  // First: exact-URL match against the curated preset list. zidecar
  // presets are the exception; anything not in the list falls through
  // to the hostname-suffix check.
  const preset = findPresetByUrl(serverUrl);
  if (preset) return preset.backend === 'zidecar';

  // Defensive parse - never throw on garbage URLs; treat unparseable
  // input as lightwalletd (the safer default since it doesn't assume
  // zidecar-only RPCs are available).
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.length === 0) return false;
  return KNOWN_ZIDECAR_HOST_SUFFIXES.some(
    suffix => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** Trust description used in UI badges / tooltips. Single source of truth. */
export function backendTrustDescription(backend: ZcashBackend): {
  readonly label: 'trustless' | 'trusted';
  readonly summary: string;
} {
  if (backend === 'zidecar') {
    return {
      label: 'trustless',
      summary:
        'Ligerito header proofs + NOMT nullifier proofs verified locally. ' +
        'The server can refuse to serve but cannot lie about chain state.',
    };
  }
  return {
    label: 'trusted',
    summary:
      'Server can lie about chain state (heights, transaction inclusion, ' +
      'nullifier set). Memos and keys stay local so privacy is intact, but ' +
      'use a server you trust for chain-state integrity.',
  };
}
