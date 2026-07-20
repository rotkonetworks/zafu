/**
 * Endpoint health probe — reaches the CompactTxStreamer GetLightdInfo RPC
 * on a Zcash preset and returns latency + tip + version + reachability.
 * Works uniformly against both `lightwalletd` and `zidecar` backends since
 * zidecar mirrors the lwd wire surface.
 *
 * The reference tip (used to compute "behind by N blocks") comes from
 * hosh.zec.rocks' JSON API (median of healthy Online servers). Cached
 * for 60s. Falls back to peer median across the probed set if hosh is
 * unreachable.
 */

import type { ZcashEndpointPreset } from '../../config/zcash-endpoints';

const SERVICE = 'cash.z.wallet.sdk.rpc.CompactTxStreamer';
const PROBE_TIMEOUT_MS = 5000;
const HOSH_URL = 'https://hosh.zec.rocks/api/v0/zec.json';
const HOSH_TTL_MS = 60_000;

export interface LightdInfo {
  /** lwd protocol version (e.g. "0.4.18") — reported to wallets */
  version: string;
  /** free-form vendor string (e.g. "zidecar/rotkonetworks") */
  vendor: string;
  chainName: string;
  saplingActivationHeight: number;
  consensusBranchId: string;
  blockHeight: number;
  gitCommit: string;
  buildDate: string;
  estimatedHeight: number;
}

export interface EndpointHealth {
  presetId: string;
  /** round-trip latency of the GetLightdInfo probe in milliseconds */
  latencyMs: number;
  /** parsed LightdInfo, or null on error */
  info: LightdInfo | null;
  /** referenceTip - tip; null if reference isn't available or endpoint unreachable */
  behindBy: number | null;
  ok: boolean;
  error?: string;
  measuredAt: number;
}

/** Fetch LightdInfo from a single endpoint, timing the round-trip. */
export async function probeEndpoint(
  preset: ZcashEndpointPreset,
  referenceTip?: number | null,
  signal?: AbortSignal,
): Promise<EndpointHealth> {
  const started = performance.now();
  try {
    const info = await fetchLightdInfo(preset.url, signal);
    const latencyMs = Math.round(performance.now() - started);
    const tip = info.blockHeight;
    const behindBy = referenceTip != null && tip > 0 ? Math.max(0, referenceTip - tip) : null;
    return {
      presetId: preset.id,
      latencyMs,
      info,
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
  }
}

/** Probe every candidate concurrently. */
export async function probeAll(
  presets: readonly ZcashEndpointPreset[],
  referenceTip?: number | null,
  signal?: AbortSignal,
): Promise<EndpointHealth[]> {
  return Promise.all(presets.map(p => probeEndpoint(p, referenceTip, signal)));
}

interface HoshCache {
  tip: number;
  fetchedAt: number;
}
let hoshCache: HoshCache | null = null;

/**
 * Median block height of healthy servers on hosh.zec.rocks.
 * Cached 60s. Returns null on network error / no healthy servers /
 * unparseable payload — callers can fall back to `peerMedianTip`.
 */
export async function getReferenceTip(signal?: AbortSignal): Promise<number | null> {
  if (hoshCache && Date.now() - hoshCache.fetchedAt < HOSH_TTL_MS) {
    return hoshCache.tip;
  }
  try {
    const resp = await fetch(HOSH_URL, { signal });
    if (!resp.ok) {
      return null;
    }
    const data: unknown = await resp.json();
    // hosh returns either { servers: [...] } or a bare array (both observed)
    const servers = extractServers(data);
    const heights = servers
      .filter(s => (s.status ?? '').toLowerCase() === 'online')
      .map(s => s.height ?? 0)
      .filter(h => h > 0)
      .sort((a, b) => a - b);
    if (heights.length === 0) {
      return null;
    }
    const median = heights[Math.floor(heights.length / 2)]!;
    hoshCache = { tip: median, fetchedAt: Date.now() };
    return median;
  } catch {
    return null;
  }
}

/** Peer-median fallback if hosh is unreachable. */
export function peerMedianTip(healths: readonly EndpointHealth[]): number | null {
  const heights = healths
    .filter(h => h.ok && h.info && h.info.blockHeight > 0)
    .map(h => h.info!.blockHeight)
    .sort((a, b) => a - b);
  if (heights.length === 0) {
    return null;
  }
  return heights[Math.floor(heights.length / 2)]!;
}

// ── implementation details ──────────────────────────────────────────

interface HoshServer {
  status?: string;
  height?: number;
}

function extractServers(data: unknown): HoshServer[] {
  if (Array.isArray(data)) {
    return data as HoshServer[];
  }
  if (data && typeof data === 'object' && 'servers' in data) {
    const s = (data as { servers: unknown }).servers;
    if (Array.isArray(s)) {
      return s as HoshServer[];
    }
  }
  return [];
}

async function fetchLightdInfo(baseUrl: string, signal?: AbortSignal): Promise<LightdInfo> {
  const path = `${baseUrl.replace(/\/$/, '')}/${SERVICE}/GetLightdInfo`;
  // gRPC frame: [flags:1][length:4][body]. Empty body → 5 zero bytes.
  const emptyFrame = new Uint8Array([0, 0, 0, 0, 0]);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), PROBE_TIMEOUT_MS);
  const combined = signal ? mergeSignals(signal, timeout.signal) : timeout.signal;
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/grpc' },
      body: emptyFrame,
      signal: combined,
    });
    if (!resp.ok) {
      throw new Error(`http ${resp.status}`);
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    return parseLightdInfo(buf);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Parse a gRPC-framed protobuf LightdInfo response.
 *
 * Message shape (from lightwalletd service.proto):
 *   1  string version
 *   2  string vendor
 *   3  bool   taddrSupport
 *   4  string chainName
 *   5  uint64 saplingActivationHeight
 *   6  string consensusBranchId
 *   7  uint64 blockHeight
 *   8  string gitCommit
 *   9  string branch
 *  10  string buildDate
 *  11  string buildUser
 *  12  uint64 estimatedHeight
 *
 * Only the fields the UI actually surfaces are decoded; the rest are skipped.
 */
function parseLightdInfo(buf: Uint8Array): LightdInfo {
  if (buf.length < 5) {
    throw new Error('short response');
  }
  const flags = buf[0]!;
  if (flags & 0x80) {
    // trailer-only response: server sent an error status in trailers rather than a message
    throw new Error('server sent trailer-only response');
  }
  const msgLen = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
  const body = buf.subarray(5, 5 + msgLen);

  const out: LightdInfo = {
    version: '',
    vendor: '',
    chainName: '',
    consensusBranchId: '',
    gitCommit: '',
    buildDate: '',
    saplingActivationHeight: 0,
    blockHeight: 0,
    estimatedHeight: 0,
  };
  const dec = new TextDecoder();
  let p = 0;
  while (p < body.length) {
    const [tag, afterTag] = readVarint(body, p);
    p = afterTag;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 2) {
      const [len, afterLen] = readVarint(body, p);
      const l = Number(len);
      p = afterLen;
      const val = body.subarray(p, p + l);
      p += l;
      const s = dec.decode(val);
      switch (field) {
        case 1:
          out.version = s;
          break;
        case 2:
          out.vendor = s;
          break;
        case 4:
          out.chainName = s;
          break;
        case 6:
          out.consensusBranchId = s;
          break;
        case 8:
          out.gitCommit = s;
          break;
        case 10:
          out.buildDate = s;
          break;
      }
    } else if (wire === 0) {
      const [val, afterVal] = readVarint(body, p);
      p = afterVal;
      switch (field) {
        case 5:
          out.saplingActivationHeight = Number(val);
          break;
        case 7:
          out.blockHeight = Number(val);
          break;
        case 12:
          out.estimatedHeight = Number(val);
          break;
      }
    } else {
      // wire types 1 (64-bit) / 5 (32-bit): none of the decoded fields use them.
      // Skip the message rather than mishandle unknown wire types.
      break;
    }
  }
  return out;
}

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let p = start;
  while (p < buf.length) {
    const b = buf[p]!;
    result |= BigInt(b & 0x7f) << shift;
    p += 1;
    if ((b & 0x80) === 0) {
      return [result, p];
    }
    shift += 7n;
    if (shift > 63n) {
      throw new Error('varint too long');
    }
  }
  throw new Error('unexpected end of varint');
}
