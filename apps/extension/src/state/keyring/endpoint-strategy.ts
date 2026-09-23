/**
 * Endpoint selection strategies.
 *
 * Given probed endpoints, rank them best-first per a user-selected policy:
 *   fastest      — lowest latency first (Zashi's default, and ours).
 *   most-synced  — smallest behindBy first.
 *   random       — session-random shuffle; picks change on rerank.
 *   manual       — never auto-pick; keep whatever the user last chose.
 *                  rankEndpoints returns [] and pickEndpoint returns null
 *                  so the caller sees the same "no candidate" signal it
 *                  gets when every endpoint is unhealthy — treat it as
 *                  "leave the current selection alone".
 *
 * "Healthy" filter is applied before ranking: unreachable and severely
 * lagging endpoints are dropped. The threshold is generous enough to
 * not exclude a node that's a few blocks behind tip during propagation.
 */

import type { ZcashEndpointPreset } from '../../config/zcash-endpoints';
import type { EndpointHealth } from './endpoint-health';

/**
 * Minimal shape a strategy needs from a preset — just an id to key health
 * lookups by, plus a url so pickers can act on the winner. Made explicit so
 * non-Zcash preset types (Penumbra) can satisfy `Candidate` structurally
 * without pulling Zcash-only fields (backend, isDefault) into shared code.
 */
export interface EndpointLike {
  readonly id: string;
  readonly url: string;
}

export type SelectionStrategy = 'fastest' | 'most-synced' | 'random' | 'manual';
export const DEFAULT_STRATEGY: SelectionStrategy = 'fastest';

/** True when the strategy explicitly opts out of any auto-selection. */
export const isManualStrategy = (s: SelectionStrategy): s is 'manual' => s === 'manual';

/** Endpoints > this many blocks behind reference are excluded. */
export const MAX_HEALTHY_BEHIND = 1000;

export interface Candidate<TPreset extends EndpointLike = ZcashEndpointPreset> {
  preset: TPreset;
  /** Latest probe result; null if not yet measured. */
  health: EndpointHealth | null;
}

/**
 * Rank candidates best-first per strategy. Unhealthy candidates are dropped.
 * If everyone is unhealthy the result is empty — caller must fall back
 * (typically: keep the user's current selection and show a warning).
 */
export function rankEndpoints<TPreset extends EndpointLike>(
  candidates: readonly Candidate<TPreset>[],
  strategy: SelectionStrategy,
): Candidate<TPreset>[] {
  // Manual mode opts out of ranking entirely. Returning [] gives every
  // caller the same "leave the current selection as-is" signal they use
  // for the "all unhealthy" case — no separate branch to maintain.
  if (strategy === 'manual') {
    return [];
  }
  const healthy = candidates.filter(isHealthy);
  if (healthy.length === 0) {
    return [];
  }
  const arr = healthy.slice();
  switch (strategy) {
    case 'most-synced':
      arr.sort((a, b) => (a.health!.behindBy ?? Infinity) - (b.health!.behindBy ?? Infinity));
      return arr;
    case 'random':
      // Fisher-Yates. Math.random is fine — this isn't a security-sensitive
      // shuffle, just query-correlation noise.
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
      }
      return arr;
    case 'fastest':
    default:
      arr.sort((a, b) => a.health!.latencyMs - b.health!.latencyMs);
      return arr;
  }
}

/** Pick a single endpoint under the strategy, or null if none healthy. */
export function pickEndpoint<TPreset extends EndpointLike>(
  candidates: readonly Candidate<TPreset>[],
  strategy: SelectionStrategy,
): Candidate<TPreset> | null {
  const ranked = rankEndpoints(candidates, strategy);
  return ranked[0] ?? null;
}

// ── internals ────────────────────────────────────────────────────────

function isHealthy<TPreset extends EndpointLike>(c: Candidate<TPreset>): boolean {
  if (!c.health || !c.health.ok) {
    return false;
  }
  if (c.health.behindBy != null && c.health.behindBy > MAX_HEALTHY_BEHIND) {
    return false;
  }
  return true;
}
