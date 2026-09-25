/**
 * Preset list of Penumbra gRPC-Web RPC endpoints, grouped by region.
 *
 * Two layers:
 *   - A hardcoded fallback list ({@link PENUMBRA_MAINNET_ENDPOINTS}) so the
 *     settings panel is never bricked when the registry fetch is slow or
 *     offline. `penumbra.rotko.net` is the shipped default (matches every
 *     other rotko fork).
 *   - {@link getRegistryEndpoints} hydrates the extra community-run RPCs
 *     from `@penumbrafi/registry` at runtime. The registry ships
 *     `EntityMetadata = { name, url, images }` with no region info, so we
 *     bucket registry entries into `community` by default (or `default`
 *     when the URL matches a hardcoded preset).
 *
 * The `region` field is shared with the Zcash preset shape so
 * `groupPresetsByRegion` from config/zcash-endpoints can be reused.
 */

import { ChainRegistryClient } from '@penumbrafi/registry';
import type { RpcEndpointRegion } from './zcash-endpoints';

export interface PenumbraEndpointPreset {
  /** stable id; used to key latency/health maps and match user selections. */
  readonly id: string;
  /** user-visible label (operator name). */
  readonly label: string;
  /** full https URL (no trailing slash). value goes into NetworkConfig.endpoint */
  readonly url: string;
  /** geographic / trust classification for the regional grouping UI */
  readonly region: RpcEndpointRegion;
  /** the shipped default for a fresh wallet */
  readonly isDefault?: boolean;
  /** true when this row was hydrated from the on-chain registry */
  readonly fromRegistry?: boolean;
}

/**
 * Hardcoded fallback presets. Order = visual order (within region).
 *
 * Region tags for the community RPCs are best-effort — the operator names
 * don't cleanly imply a geography (silentvalidator, ghostinnet, crouton,
 * radiantcommons all serve global traffic from single POPs). They ride
 * under `community` so the region bucket in the picker is the honest one.
 */
export const PENUMBRA_MAINNET_ENDPOINTS: readonly PenumbraEndpointPreset[] = [
  // ── default (rotko, shipped) ──
  {
    id: 'rotko',
    label: 'rotko',
    url: 'https://penumbra.rotko.net',
    region: 'default',
    isDefault: true,
  },

  // ── community-run rpcs (mirrors the bundled @penumbrafi/registry) ──
  {
    id: 'radiantcommons',
    label: 'radiant commons',
    url: 'https://penumbra-1.radiantcommons.com',
    region: 'community',
  },
  {
    id: 'crouton',
    label: 'crouton digital',
    url: 'https://penumbra.crouton.digital',
    region: 'community',
  },
  {
    id: 'silentvalidator',
    label: 'silent validator',
    url: 'https://grpc.penumbra.silentvalidator.com',
    region: 'community',
  },
  {
    id: 'ghostinnet',
    label: 'ghostinnet',
    url: 'https://penumbra.grpc.ghostinnet.com',
    region: 'community',
  },
];

const stripTrailingSlash = (u: string): string => u.replace(/\/$/, '');
const normalize = (u: string): string => stripTrailingSlash(u).toLowerCase();

/** Find a preset by URL (used to label a user's current endpoint). */
export function findPenumbraPresetByUrl(
  url: string,
  presets: readonly PenumbraEndpointPreset[] = PENUMBRA_MAINNET_ENDPOINTS,
): PenumbraEndpointPreset | undefined {
  const target = normalize(url);
  return presets.find(p => normalize(p.url) === target);
}

export function defaultPenumbraEndpoint(): PenumbraEndpointPreset {
  return (
    PENUMBRA_MAINNET_ENDPOINTS.find(p => p.isDefault) ?? PENUMBRA_MAINNET_ENDPOINTS[0]!
  );
}

/** Turn an operator name into a stable, url-safe id. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'unnamed';
}

/**
 * Hydrate the preset list from `@penumbrafi/registry`.
 *
 * Strategy:
 *   - Start with the hardcoded fallback list so the shipped default and
 *     region assignments always win.
 *   - Fold in every registry entry that isn't already covered by URL. New
 *     entries land in the `community` bucket (registry entries don't carry
 *     geographic metadata).
 *   - Prefer the bundled reader (`bundled.globals()`) so the panel renders
 *     synchronously; the caller can later re-hydrate via `remote.globals()`
 *     if a fresher list matters (it doesn't for a first render).
 *
 * Never throws — a broken registry falls back to the hardcoded list.
 */
export function getRegistryEndpoints(): readonly PenumbraEndpointPreset[] {
  try {
    const client = new ChainRegistryClient();
    const bundled = client.bundled.globals();
    return mergeRegistry(PENUMBRA_MAINNET_ENDPOINTS, bundled.rpcs);
  } catch {
    return PENUMBRA_MAINNET_ENDPOINTS;
  }
}

/** Async variant that pulls from the remote registry (github). */
export async function getRegistryEndpointsRemote(): Promise<readonly PenumbraEndpointPreset[]> {
  try {
    const client = new ChainRegistryClient();
    const remote = await client.remote.globals();
    return mergeRegistry(PENUMBRA_MAINNET_ENDPOINTS, remote.rpcs);
  } catch {
    return getRegistryEndpoints();
  }
}

function mergeRegistry(
  base: readonly PenumbraEndpointPreset[],
  registryRpcs: readonly { readonly name: string; readonly url: string }[],
): readonly PenumbraEndpointPreset[] {
  const seen = new Set(base.map(p => normalize(p.url)));
  const merged: PenumbraEndpointPreset[] = [...base];
  for (const r of registryRpcs) {
    const url = stripTrailingSlash(r.url);
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }
    const key = normalize(url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      id: `registry-${slugify(r.name)}`,
      label: r.name,
      url,
      region: 'community',
      fromRegistry: true,
    });
  }
  return merged;
}
