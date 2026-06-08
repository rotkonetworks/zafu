/**
 * Endpoint latency measurement.
 *
 * Probes only GetTip - the universal RPC that both zidecar and
 * lightwalletd implement. Avoids the fingerprinting beacon problem
 * of probing zidecar-only RPCs against arbitrary endpoints.
 *
 * Manual trigger only: settings UI calls measurePresetLatencies()
 * on user click; no background polling, no probe on settings entry.
 */

import { zcashClientFor, isZidecarEndpoint } from './zcash-backend';
import { ZCASH_MAINNET_ENDPOINTS } from '../../config/zcash-endpoints';

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
 * Measure all mainnet presets in parallel, return as a Map keyed by URL.
 * Unreachable endpoints have rttMs === null.
 */
export async function measurePresetLatencies(): Promise<Map<string, EndpointLatency>> {
  const results = await Promise.all(
    ZCASH_MAINNET_ENDPOINTS.map(p => measureEndpointLatency(p.url)),
  );
  const m = new Map<string, EndpointLatency>();
  results.forEach(r => m.set(r.url, r));
  return m;
}
