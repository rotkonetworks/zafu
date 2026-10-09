// zidecar (verified) vs standard lightwalletd, detected from the node itself.

import type { LightdInfo } from './lightd-info';
import { ZidecarClient } from './zidecar-client';
import { LightwalletdClient } from './lightwalletd-client';
import type { ChainTip, CompactBlock, Utxo } from './zcash-types';
import type { SubtreePool, SubtreeRoot } from './subtree-roots';
import { findPresetByUrl } from '../../config/zcash-endpoints';
import { eachAddress } from './each-address';

export type { ChainTip, CompactAction, CompactBlock, Utxo } from './zcash-types';

export type ZcashBackend = 'zidecar' | 'lightwalletd';

/**
 * Everything that differs by backend, in one place. A standard lightwalletd
 * is used like every other lightwalletd wallet uses it; zidecar adds its own
 * rpcs (proofs, mempool, whole-block transactions, anchor attestation), and
 * code reaches them only through `extras`, so nothing can call them on a
 * lightwalletd.
 */
export interface ZcashBackendProfile {
  readonly client: (url: string, signal?: AbortSignal) => ZcashClient;
  readonly extras?: (url: string, signal?: AbortSignal) => ZidecarClient;
  /** zidecar's SendResponse carries the txid; standard lightwalletd's does not */
  readonly echoesTxid: boolean;
}

export const ZCASH_BACKENDS: Readonly<Record<ZcashBackend, ZcashBackendProfile>> = {
  zidecar: {
    client: (url, signal) => new ZidecarClient(url, signal),
    extras: (url, signal) => new ZidecarClient(url, signal),
    echoesTxid: true,
  },
  lightwalletd: {
    client: (url, signal) => new LightwalletdClient(url, signal),
    echoesTxid: false,
  },
};

export const isZcashBackend = (b: unknown): b is ZcashBackend =>
  typeof b === 'string' && Object.hasOwn(ZCASH_BACKENDS, b);

/** zidecar's own rpcs for this backend, or undefined on a standard lightwalletd */
export const zidecarExtras = (
  url: string,
  backend: unknown,
  signal?: AbortSignal,
): ZidecarClient | undefined =>
  isZcashBackend(backend) ? ZCASH_BACKENDS[backend].extras?.(url, signal) : undefined;

/** `signal`: a stopped run's client sends nothing more, and its requests in flight end */
export const zcashClient = (
  url: string,
  backend: ZcashBackend,
  signal?: AbortSignal,
): ZcashClient => ZCASH_BACKENDS[backend].client(url, signal);

export const utxosEach = (
  client: Pick<ZcashClient, 'getAddressUtxos'>,
  addresses: readonly string[],
) => eachAddress(addresses, a => client.getAddressUtxos(a));

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
  /** roots of the pool's complete 2^16-leaf subtrees, from `startIndex` (lightwalletd GetSubtreeRoots) */
  getSubtreeRoots(pool: SubtreePool, startIndex: number): Promise<SubtreeRoot[]>;
  /** one address per request: a request naming several tells the node they are one wallet */
  getAddressUtxos(address: string, startHeight?: number, maxEntries?: number): Promise<Utxo[]>;
  getTaddressTxids(address: string, startHeight?: number): Promise<Uint8Array[]>;
  getTransaction(txid: Uint8Array): Promise<{ data: Uint8Array; height: number }>;
  getBlockTime(height: number): Promise<number>;
  /**
   * lightwalletd `GetLightdInfo` (both backends serve it; zidecar via its
   * CompactTxStreamer compatibility layer). `consensusBranchId` is the hex
   * branch id the endpoint's node reports for the current chain tip - the
   * NU6.3 turnstile builder fails closed unless this matches the real NU6.3
   * value (0x37a5165b) and is not the placeholder 0xffffffff.
   */
  /** vendor is free-form; zidecar answers "zidecar/rotkonetworks" */
  getLightdInfo(): Promise<LightdInfo>;
  sendTransaction(
    txData: Uint8Array,
  ): Promise<{ txid: Uint8Array; errorCode: number; errorMessage: string }>;
}

/**
 * What kind of node an endpoint is, told by the node itself.
 *
 * zafu never asks the user, and never sends a zidecar-only rpc to find out:
 * a `zidecar.v1.*` request is a request signature no other Zcash wallet
 * makes, so even a failed probe would mark the wallet as zafu. The question
 * is asked with lightwalletd's own `GetLightdInfo`, the call every light
 * wallet makes, and answered from its `vendor` field. zidecar has answered
 * "zidecar/rotkonetworks" there since v0.5.4; anything else (another
 * vendor, a blank one, a node that will not say) is a standard lightwalletd,
 * which is the safe reading: zafu then makes only standard calls.
 */
export const classifyLightdInfo = (info: { vendor?: unknown }): ZcashBackend =>
  typeof info.vendor === 'string' && /^zidecar\b/i.test(info.vendor.trim())
    ? 'zidecar'
    : 'lightwalletd';

/** one spelling per endpoint, for the per-endpoint cache and the worker registry */
export const backendKey = (serverUrl: string): string =>
  serverUrl.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Ask the node what it is, with standard calls only. Native gRPC first (what
 * lightwalletd wallets send); a node behind a grpc-web-only proxy answers the
 * same rpc over grpc-web, which every browser wallet speaks. Throws when the
 * node answers neither, so a caller keeps what it already knew.
 */
export const detectZcashBackend = async (serverUrl: string): Promise<ZcashBackend> => {
  let info: { vendor: string };
  try {
    info = await new LightwalletdClient(serverUrl).getLightdInfo();
  } catch {
    info = await new ZidecarClient(serverUrl).getLightdInfo();
  }
  return classifyLightdInfo(info);
};

/**
 * Re-ask a node what it is after one of zidecar's own calls failed, at most
 * once per `cooldownMs` per endpoint. Resolves to the node's answer, or
 * undefined when it was asked too recently or did not answer - a node that
 * blinked keeps its kind; only an answer changes it.
 */
export const createRedetector = (
  detect: (serverUrl: string) => Promise<ZcashBackend> = detectZcashBackend,
  { cooldownMs = 10 * 60_000, now = Date.now }: { cooldownMs?: number; now?: () => number } = {},
) => {
  const askedAt = new Map<string, number>();
  return async (serverUrl: string): Promise<ZcashBackend | undefined> => {
    const key = backendKey(serverUrl);
    const last = askedAt.get(key);
    if (last !== undefined && now() - last < cooldownMs) {
      return undefined;
    }
    askedAt.set(key, now());
    try {
      return await detect(serverUrl);
    } catch {
      return undefined;
    }
  };
};

/**
 * The best guess before a node has answered: a shipped preset or a rotko
 * host is zidecar, anything else a standard lightwalletd. Only a guess -
 * detection replaces it - and it never guesses zidecar for a third party,
 * so an unclassified host never sees a zidecar-only rpc.
 */
const KNOWN_ZIDECAR_HOST_SUFFIXES: readonly string[] = ['rotko.net'];

export const backendOfEndpoint = (serverUrl: string): ZcashBackend =>
  isZidecarEndpoint(serverUrl) ? 'zidecar' : 'lightwalletd';

function isZidecarEndpoint(serverUrl: string): boolean {
  const preset = findPresetByUrl(serverUrl);
  if (preset) {
    return preset.backend === 'zidecar';
  }
  // never throw on a garbage url; an unparseable one is no zidecar
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
