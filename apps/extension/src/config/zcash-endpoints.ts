/**
 * Preset list of zcash light-wallet endpoints, grouped by region.
 *
 * Two flavors:
 *   - zidecar — rotko-hosted, trustless verification (Ligerito + NOMT
 *     proofs). Mempool watch works on this backend.
 *   - lightwalletd — public ECC lightwalletd / Zaino. Trusted (the
 *     wallet accepts what the server returns). Mempool watch is
 *     unavailable on this backend.
 *
 * Anything mentioned in `KNOWN_ZIDECAR_HOST_SUFFIXES`
 * (state/keyring/zcash-backend.ts) is classified as zidecar
 * automatically at runtime. Anything else gets the lightwalletd
 * (trusted) treatment.
 *
 * Vizor's preset set is the inspiration here — the goal is "the user
 * has a working fallback if their default node is down". For zafu's
 * privacy story, zidecar endpoints are preferable; the public
 * lightwalletd endpoints are listed as honest fallbacks.
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
  /** trustless (zidecar) vs trusted (lightwalletd) */
  readonly backend: ZcashBackend;
  /** the shipped default for a fresh wallet */
  readonly isDefault?: boolean;
}

/**
 * Mainnet preset list. Order = visual order in the picker.
 *
 * Defaults to rotko's zidecar (trustless) because that's the only
 * surface where the wallet's privacy/verification properties hold
 * end-to-end. Anyone who can't reach it has the public lightwalletd
 * fallbacks one tap away.
 */
export const ZCASH_MAINNET_ENDPOINTS: ReadonlyArray<ZcashEndpointPreset> = [
  // ── default (trustless) ──
  {
    id: 'rotko-zidecar',
    label: 'rotko zidecar (trustless)',
    url: 'https://zcash.rotko.net',
    region: 'default',
    backend: 'zidecar',
    isDefault: true,
  },

  // ── stardust family (trusted lightwalletd) ──
  {
    id: 'stardust-us',
    label: 'stardust us',
    url: 'https://us.zec.stardust.rest:443',
    region: 'americas',
    backend: 'lightwalletd',
  },
  {
    id: 'stardust-eu',
    label: 'stardust europe',
    url: 'https://eu.zec.stardust.rest:443',
    region: 'europe',
    backend: 'lightwalletd',
  },
  {
    id: 'stardust-eu2',
    label: 'stardust europe 2',
    url: 'https://eu2.zec.stardust.rest:443',
    region: 'europe',
    backend: 'lightwalletd',
  },
  {
    id: 'stardust-jp',
    label: 'stardust japan',
    url: 'https://jp.zec.stardust.rest:443',
    region: 'asia-pacific',
    backend: 'lightwalletd',
  },

  // ── zec.rocks family (trusted lightwalletd) ──
  {
    id: 'zec-rocks',
    label: 'zec.rocks (global)',
    url: 'https://zec.rocks:443',
    region: 'global',
    backend: 'lightwalletd',
  },
  {
    id: 'zec-rocks-na',
    label: 'zec.rocks north america',
    url: 'https://na.zec.rocks:443',
    region: 'americas',
    backend: 'lightwalletd',
  },
  {
    id: 'zec-rocks-sa',
    label: 'zec.rocks south america',
    url: 'https://sa.zec.rocks:443',
    region: 'americas',
    backend: 'lightwalletd',
  },
  {
    id: 'zec-rocks-eu',
    label: 'zec.rocks europe',
    url: 'https://eu.zec.rocks:443',
    region: 'europe',
    backend: 'lightwalletd',
  },
  {
    id: 'zec-rocks-ap',
    label: 'zec.rocks asia pacific',
    url: 'https://ap.zec.rocks:443',
    region: 'asia-pacific',
    backend: 'lightwalletd',
  },

  // ── community ──
  {
    id: 'zcash-explorer',
    label: 'zcash explorer',
    url: 'https://lwd.zcashexplorer.app:9067',
    region: 'community',
    backend: 'lightwalletd',
  },
];

/** Find a preset by URL (used to label a user's current endpoint). */
export function findPresetByUrl(url: string): ZcashEndpointPreset | undefined {
  const normalized = url.replace(/\/$/, '').toLowerCase();
  return ZCASH_MAINNET_ENDPOINTS.find(
    p => p.url.replace(/\/$/, '').toLowerCase() === normalized,
  );
}

export function findPresetById(id: string): ZcashEndpointPreset | undefined {
  return ZCASH_MAINNET_ENDPOINTS.find(p => p.id === id);
}

export function defaultZcashEndpoint(): ZcashEndpointPreset {
  return ZCASH_MAINNET_ENDPOINTS.find(p => p.isDefault) ?? ZCASH_MAINNET_ENDPOINTS[0]!;
}

/** Group presets by region for the dropdown UI. */
export function groupPresetsByRegion(
  presets: ReadonlyArray<ZcashEndpointPreset> = ZCASH_MAINNET_ENDPOINTS,
): ReadonlyArray<{ region: RpcEndpointRegion; presets: ZcashEndpointPreset[] }> {
  const order: RpcEndpointRegion[] = ['default', 'global', 'americas', 'europe', 'asia-pacific', 'community'];
  const groups = new Map<RpcEndpointRegion, ZcashEndpointPreset[]>();
  for (const p of presets) {
    if (!groups.has(p.region)) groups.set(p.region, []);
    groups.get(p.region)!.push(p);
  }
  return order
    .filter(r => groups.has(r))
    .map(r => ({ region: r, presets: groups.get(r)! }));
}
