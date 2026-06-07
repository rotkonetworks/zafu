/**
 * Endpoint latency measurement.
 *
 * Probes only GetTip - the universal RPC that both zidecar and
 * lightwalletd implement. Avoids the fingerprinting beacon problem
 * of probing zidecar-only RPCs against arbitrary endpoints.
 *
 * Manual trigger only: settings UI calls measureCuratedLatencies()
 * on user click; no background polling, no probe on settings entry.
 */

import { zcashClientFor, isZidecarEndpoint } from './zcash-backend';
import { CURATED_ZCASH_ENDPOINTS } from './endpoint-registry';

export interface EndpointLatency {
  readonly url: string;
  readonly rttMs: number | null;
  readonly error?: string;
}

const PROBE_TIMEOUT_MS = 5000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms),
    ),
  ]);
}

export async function measureEndpointLatency(url: string): Promise<EndpointLatency> {
  const start = performance.now();
  try {
    const backend = isZidecarEndpoint(url) ? 'zidecar' : 'lightwalletd';
    const client = await zcashClientFor(url, backend);
    await withTimeout(client.getTip(), PROBE_TIMEOUT_MS);
    return { url, rttMs: Math.round(performance.now() - start) };
  } catch (e) {
    return {
      url,
      rttMs: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Measure all curated endpoints in parallel, return sorted by RTT.
 * Unreachable endpoints (rttMs === null) sort to the end.
 */
export async function measureCuratedLatencies(): Promise<EndpointLatency[]> {
  const results = await Promise.all(
    CURATED_ZCASH_ENDPOINTS.map(e => measureEndpointLatency(e.url)),
  );
  return results.sort((a, b) => {
    if (a.rttMs === null && b.rttMs === null) return 0;
    if (a.rttMs === null) return 1;
    if (b.rttMs === null) return -1;
    return a.rttMs - b.rttMs;
  });
}
