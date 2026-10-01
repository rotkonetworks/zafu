/** What a node probe reports: latency, tip, version and reachability. */

export interface LightdInfo {
  /** lwd protocol version (e.g. "0.4.18") - reported to wallets */
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
