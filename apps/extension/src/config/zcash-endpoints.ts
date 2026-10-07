/**
 * Preset list of zcash light-wallet endpoints.
 *
 * A preset MUST be reachable from a browser: it has to answer a grpc-web
 * (not native grpc) request, and its CORS preflight has to succeed for a
 * `chrome-extension://` origin. Probed 2026-10-02 with curl (a grpc-web
 * POST plus a CORS preflight from a chrome-extension origin): every
 * stardust host, every zec.rocks host and lwd.zcashexplorer.app either
 * fail the preflight (301/404/415, or no connection) or answer with
 * native `application/grpc`, which a browser client cannot speak. Picking
 * one of those left users stuck on "gRPC GetLatestBlock: empty response"
 * or an HTTP 415 with sync stalled. Only rotko's zidecar answers
 * grpc-web with CORS, so it is the only preset shipped.
 *
 * Anyone running their own grpc-web-speaking proxy (Envoy, or Zaino with
 * grpc-web turned on) can still enter it by hand: the custom-endpoint
 * entry in settings and the lightwalletd backend code path both stay.
 *
 * Two backend flavors (see state/keyring/zcash-backend.ts):
 *   - zidecar - rotko-hosted; mempool watch.
 *   - lightwalletd - public ECC lightwalletd / Zaino. Mempool watch is
 *     unavailable on this backend.
 *
 * Either way the node is trusted for chain data: the wallet scans what it is
 * served, so a node can hide or delay a payment, or show a spent note as
 * unspent (that spend then fails). It never sees a key and cannot move
 * funds. Nothing on either backend proves the chain to the wallet.
 *
 * The user is never asked which one a node is: the node says, through the
 * standard GetLightdInfo `vendor` (detectZcashBackend). A preset's
 * `backend` is only the guess that stands until it has answered.
 */

import type { ZcashBackend } from '../state/keyring/zcash-backend';

export type RpcEndpointRegion =
  | 'default'
  | 'global'
  | 'europe'
  | 'asia-pacific'
  | 'americas'
  | 'community';

export interface ZcashEndpointPreset {
  /** stable id; used in storage for "which preset is currently picked" */
  readonly id: string;
  /** user-visible label */
  readonly label: string;
  /** full https URL (with port). value goes into NetworkConfig.endpoint */
  readonly url: string;
  /** geographic / trust classification for the regional grouping UI */
  readonly region: RpcEndpointRegion;
  /** zidecar or lightwalletd, until the node itself says (both are trusted for chain data) */
  readonly backend: ZcashBackend;
  /** the shipped default for a fresh wallet */
  readonly isDefault?: boolean;
}

/**
 * Mainnet preset list. Order = visual order in the picker.
 *
 * Defaults to rotko's zidecar: the only preset that answers grpc-web with
 * CORS, and the one with mempool watch. It is
 * trusted for chain data like any other node. Anyone who can't reach it has
 * the public lightwalletd fallbacks one tap away.
 */
export const ZCASH_MAINNET_ENDPOINTS: readonly ZcashEndpointPreset[] = [
  {
    id: 'rotko-zidecar',
    label: 'rotko',
    url: 'https://zcash.rotko.net',
    region: 'default',
    backend: 'zidecar',
    isDefault: true,
  },
];

/** Find a preset by URL (used to label a user's current endpoint). */
export function findPresetByUrl(url: string): ZcashEndpointPreset | undefined {
  const normalized = url.replace(/\/$/, '').toLowerCase();
  return ZCASH_MAINNET_ENDPOINTS.find(p => p.url.replace(/\/$/, '').toLowerCase() === normalized);
}

export function findPresetById(id: string): ZcashEndpointPreset | undefined {
  return ZCASH_MAINNET_ENDPOINTS.find(p => p.id === id);
}

export function defaultZcashEndpoint(): ZcashEndpointPreset {
  return ZCASH_MAINNET_ENDPOINTS.find(p => p.isDefault) ?? ZCASH_MAINNET_ENDPOINTS[0]!;
}

/**
 * Group presets by region for the dropdown UI.
 *
 * Generic over the preset shape so the Penumbra panel can reuse the same
 * regional grouping without duplicating this logic - the helper only reads
 * `p.region`, so any `{ region: RpcEndpointRegion }` shape works.
 */
export function groupPresetsByRegion<T extends { readonly region: RpcEndpointRegion }>(
  presets: readonly T[],
): readonly { region: RpcEndpointRegion; presets: T[] }[] {
  const order: RpcEndpointRegion[] = [
    'default',
    'global',
    'americas',
    'europe',
    'asia-pacific',
    'community',
  ];
  const groups = new Map<RpcEndpointRegion, T[]>();
  for (const p of presets) {
    if (!groups.has(p.region)) {
      groups.set(p.region, []);
    }
    groups.get(p.region)!.push(p);
  }
  return order.filter(r => groups.has(r)).map(r => ({ region: r, presets: groups.get(r)! }));
}
