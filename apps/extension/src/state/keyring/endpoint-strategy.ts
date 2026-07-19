/**
 * Endpoint selection strategies.
 *
 * Given probed endpoints, rank them best-first per a user-selected policy:
 *   privacy      — .onion + zidecar > zidecar > .onion > public lwd
 *                  (tiebreak: latency). This is the shipped default.
 *   fastest      — lowest latency first (Zashi's default).
 *   most-synced  — smallest behindBy first.
 *   random       — session-random shuffle; picks change on rerank.
 *
 * "Healthy" filter is applied before ranking: unreachable and severely
 * lagging endpoints are dropped. The threshold is generous enough to
 * not exclude a node that's a few blocks behind tip during propagation.
 */

import type { ZcashEndpointPreset } from '../../config/zcash-endpoints';
import type { EndpointHealth } from './endpoint-health';

export type SelectionStrategy = 'privacy' | 'fastest' | 'most-synced' | 'random';
export const DEFAULT_STRATEGY: SelectionStrategy = 'privacy';

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
    case 'fastest':
      arr.sort((a, b) => a.health!.latencyMs - b.health!.latencyMs);
      return arr;
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
    case 'privacy':
    default:
      arr.sort((a, b) => {
        const diff = privacyRank(b.preset) - privacyRank(a.preset);
        if (diff !== 0) {
          return diff;
        }
        return a.health!.latencyMs - b.health!.latencyMs;
      });
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

/**
 * Privacy-ranking key. Higher is more private.
 *
 *   4 = tor .onion + zidecar   (client IP hidden AND trustless verification)
 *   3 = zidecar (any host)     (trustless verification, IP visible)
 *   2 = tor .onion + lwd       (client IP hidden, trusted server)
 *   1 = public lightwalletd    (everything visible)
 */
function privacyRank(preset: ZcashEndpointPreset): number {
  const isOnion = preset.url.toLowerCase().includes('.onion');
  const isZidecar = preset.backend === 'zidecar';
  if (isOnion && isZidecar) {
    return 4;
  }
  if (isZidecar) {
    return 3;
  }
  if (isOnion) {
    return 2;
  }
  return 1;
}
