/**
 * Endpoint latency + health probe for Penumbra gRPC-Web RPCs.
 *
 * Uses `TendermintProxyService.getStatus` — the tendermint-proxy shim every
 * Penumbra node exposes. One round-trip returns latest block height (for
 * "at tip" / "-N blocks" labels) plus reachability, and the same call is
 * already how `hooks/latest-block-height.ts` picks a working RPC during
 * onboarding — so we reuse the wire path the app itself relies on.
 *
 * Parallel with `Promise.allSettled`; 5s per-endpoint hard timeout; no
 * background polling — the settings panel calls this on mount + on
 * "retest" / "smart pick" clicks only.
 */

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { TendermintProxyService } from '@penumbra-zone/protobuf';
import type { PenumbraEndpointPreset } from '../../config/penumbra-endpoints';
import type { EndpointHealth } from './endpoint-health';

const PROBE_TIMEOUT_MS = 5000;

/**
 * Probe one Penumbra RPC. Returns an `EndpointHealth` so the settings
 * panel can reuse the same `Candidate` / `pickEndpoint` machinery the
 * Zcash panel uses — the shape's `info.blockHeight` field carries the
 * tendermint tip height, and `latencyMs` is the wall-clock round-trip.
 */
export async function probePenumbraEndpoint(
  preset: PenumbraEndpointPreset,
  referenceTip?: number | null,
  signal?: AbortSignal,
): Promise<EndpointHealth> {
  const started = performance.now();
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), PROBE_TIMEOUT_MS);
  const combined = signal ? mergeSignals(signal, timeoutCtl.signal) : timeoutCtl.signal;
  try {
    const client = createClient(
      TendermintProxyService,
      createGrpcWebTransport({ baseUrl: preset.url }),
    );
    const result = await client.getStatus({}, { signal: combined });
    const latencyMs = Math.round(performance.now() - started);
    const height = result.syncInfo?.latestBlockHeight
      ? Number(result.syncInfo.latestBlockHeight)
      : 0;
    if (!height) {
      return {
        presetId: preset.id,
        latencyMs,
        info: null,
        behindBy: null,
        ok: false,
        error: 'no syncInfo',
        measuredAt: Date.now(),
      };
    }
    const behindBy = referenceTip != null && height > 0 ? Math.max(0, referenceTip - height) : null;
    return {
      presetId: preset.id,
      latencyMs,
      // The rest of the LightdInfo fields don't apply on penumbra — leave
      // them empty. Only blockHeight is actually consumed by the picker.
      info: {
        version: '',
        vendor: '',
        chainName: result.nodeInfo?.network ?? '',
        consensusBranchId: '',
        gitCommit: '',
        buildDate: '',
        saplingActivationHeight: 0,
        blockHeight: height,
        estimatedHeight: 0,
      },
      behindBy,
      ok: true,
      measuredAt: Date.now(),
    };
  } catch (e) {
    return {
      presetId: preset.id,
      latencyMs: Math.round(performance.now() - started),
      info: null,
      behindBy: null,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      measuredAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every candidate concurrently. Never rejects — bad rpcs surface as `ok: false`. */
export async function probeAllPenumbra(
  presets: readonly PenumbraEndpointPreset[],
  referenceTip?: number | null,
  signal?: AbortSignal,
): Promise<EndpointHealth[]> {
  const settled = await Promise.allSettled(
    presets.map(p => probePenumbraEndpoint(p, referenceTip, signal)),
  );
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') {
      return r.value;
    }
    const preset = presets[i]!;
    return {
      presetId: preset.id,
      latencyMs: 0,
      info: null,
      behindBy: null,
      ok: false,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      measuredAt: Date.now(),
    };
  });
}

/** Peer-median tip across probed endpoints — Penumbra has no hosh-equivalent. */
export function peerMedianTipPenumbra(healths: readonly EndpointHealth[]): number | null {
  const heights = healths
    .filter(h => h.ok && h.info && h.info.blockHeight > 0)
    .map(h => h.info!.blockHeight)
    .sort((a, b) => a - b);
  if (heights.length === 0) {
    return null;
  }
  return heights[Math.floor(heights.length / 2)]!;
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  if (a.aborted || b.aborted) {
    ctrl.abort();
  }
  return ctrl.signal;
}
