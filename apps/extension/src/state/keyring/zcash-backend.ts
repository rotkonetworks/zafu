// zidecar (verified) vs standard lightwalletd endpoint selection.

import { ZidecarClient } from './zidecar-client';
import { LightwalletdClient } from './lightwalletd-client';
import type { ChainTip, CompactBlock, Utxo } from './zidecar-client';
import { findPresetByUrl } from '../../config/zcash-endpoints';

export type ZcashBackend = 'zidecar' | 'lightwalletd';

/**
 * Everything that differs by backend, in one place. A standard lightwalletd
 * is used like every other lightwalletd wallet uses it; zidecar adds its own
 * rpcs (proofs, mempool, whole-block transactions, anchor attestation), and
 * code reaches them only through `extras`, so nothing can call them on a
 * lightwalletd.
 */
export interface ZcashBackendProfile {
  /** the one short value the network screen and node sheet show */
  readonly label: string;
  readonly client: (url: string) => ZcashClient;
  readonly extras?: (url: string) => ZidecarClient;
  /** zidecar's SendResponse carries the txid; standard lightwalletd's does not */
  readonly echoesTxid: boolean;
}

export const ZCASH_BACKENDS: Readonly<Record<ZcashBackend, ZcashBackendProfile>> = {
  zidecar: {
    label: 'zidecar · verified',
    client: url => new ZidecarClient(url),
    extras: url => new ZidecarClient(url),
    echoesTxid: true,
  },
  lightwalletd: {
    label: 'lightwalletd',
    client: url => new LightwalletdClient(url),
    echoesTxid: false,
  },
};

export const isZcashBackend = (b: unknown): b is ZcashBackend =>
  typeof b === 'string' && Object.hasOwn(ZCASH_BACKENDS, b);

/** zidecar's own rpcs for this backend, or undefined on a standard lightwalletd */
export const zidecarExtras = (url: string, backend: unknown): ZidecarClient | undefined =>
  isZcashBackend(backend) ? ZCASH_BACKENDS[backend].extras?.(url) : undefined;

export const zcashClient = (url: string, backend: ZcashBackend): ZcashClient =>
  ZCASH_BACKENDS[backend].client(url);

/** The standard CompactTxStreamer surface both backends serve; ZidecarClient is a structural superset. */
export interface ZcashClient {
  getTip(): Promise<ChainTip>;
  getTreeState(height: number): Promise<{
    height: number;
    orchardTree: string;
    /**
     * NU6.3 ironwood pool frontier (hex). Optional: only present when the
     * server serves it (zidecar post-NU6.3; lightwalletd if upstream adds
     * the field). Absent on pre-upgrade servers and heights.
     */
    ironwoodTree?: string;
    time: number;
  }>;
  getCompactBlocks(startHeight: number, endHeight: number): Promise<CompactBlock[]>;
  getAddressUtxos(addresses: string[], startHeight?: number, maxEntries?: number): Promise<Utxo[]>;
  getTaddressTxids(addresses: string[], startHeight?: number): Promise<Uint8Array[]>;
  getTransaction(txid: Uint8Array): Promise<{ data: Uint8Array; height: number }>;
  getBlockTime(height: number): Promise<number>;
  /**
   * lightwalletd `GetLightdInfo` (both backends serve it; zidecar via its
   * CompactTxStreamer compatibility layer). `consensusBranchId` is the hex
   * branch id the endpoint's node reports for the current chain tip - the
   * NU6.3 turnstile builder fails closed unless this matches the real NU6.3
   * value (0x37a5165b) and is not the placeholder 0xffffffff.
   */
  getLightdInfo(): Promise<{
    consensusBranchId: string;
    chainName: string;
    blockHeight: number;
    saplingActivationHeight: number;
  }>;
  sendTransaction(
    txData: Uint8Array,
  ): Promise<{ txid: Uint8Array; errorCode: number; errorMessage: string }>;
}

/**
 * Declaratively classify an endpoint URL as zidecar-speaking or generic
 * lightwalletd.
 *
 * Design choice (defensive, hdevalence-style):
 *   We deliberately do NOT auto-probe a zidecar-only RPC at runtime.
 *   Probing `zidecar.v1.Zidecar/GetSyncStatus` against an arbitrary
 *   endpoint is a unique-to-zafu request signature - no other Zcash
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
const KNOWN_ZIDECAR_HOST_SUFFIXES: readonly string[] = ['rotko.net'];

export const backendOfEndpoint = (serverUrl: string): ZcashBackend =>
  isZidecarEndpoint(serverUrl) ? 'zidecar' : 'lightwalletd';

function isZidecarEndpoint(serverUrl: string): boolean {
  // First: exact-URL match against the curated preset list. zidecar
  // presets are the exception; anything not in the list falls through
  // to the hostname-suffix check.
  const preset = findPresetByUrl(serverUrl);
  if (preset) {
    return preset.backend === 'zidecar';
  }

  // Defensive parse - never throw on garbage URLs; treat unparseable
  // input as lightwalletd (the safer default since it doesn't assume
  // zidecar-only RPCs are available).
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.length === 0) {
    return false;
  }
  return KNOWN_ZIDECAR_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}
