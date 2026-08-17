/**
 * Endpoint selection strategies.
 *
 * Given probed endpoints, rank them best-first per a user-selected policy:
 *   fastest      — lowest latency first (Zashi's default, and ours).
 *   most-synced  — smallest behindBy first.
 *   random       — session-random shuffle; picks change on rerank.
 *
 * "Healthy" filter is applied before ranking: unreachable and severely
 * lagging endpoints are dropped. The threshold is generous enough to
 * not exclude a node that's a few blocks behind tip during propagation.
 */

import type { ZcashEndpointPreset } from '../../config/zcash-endpoints';
import type { EndpointHealth } from './endpoint-health';

export type SelectionStrategy = 'fastest' | 'most-synced' | 'random';
export const DEFAULT_STRATEGY: SelectionStrategy = 'fastest';

/** Endpoints > this many blocks behind reference are excluded. */
export const MAX_HEALTHY_BEHIND = 1000;

export interface Candidate {
  preset: ZcashEndpointPreset;
  /** Latest probe result; null if not yet measured. */
  health: EndpointHealth | null;
}

/**
 * Rank candidates best-first per strategy. Unhealthy candidates are dropped.
 * If everyone is unhealthy the result is empty — caller must fall back
 * (typically: keep the user's current selection and show a warning).
 */
export function rankEndpoints(
  candidates: readonly Candidate[],
  strategy: SelectionStrategy,
): Candidate[] {
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
export function pickEndpoint(
  candidates: readonly Candidate[],
  strategy: SelectionStrategy,
): Candidate | null {
  const ranked = rankEndpoints(candidates, strategy);
  return ranked[0] ?? null;
}

// ── internals ────────────────────────────────────────────────────────

function isHealthy(c: Candidate): boolean {
  if (!c.health || !c.health.ok) {
    return false;
  }
  if (c.health.behindBy != null && c.health.behindBy > MAX_HEALTHY_BEHIND) {
    return false;
  }
  return true;
}
