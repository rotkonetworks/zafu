/**
 * Shared types for the Zafu firmware-OTA wire contract.
 *
 * All wire schemas mirror the frozen field numbers in
 * docs/design/zafu-ota-wire-freeze.md.
 */

/** Supported firmware `class` values (signed, whitelisted). */
export type FwClass = 'release' | 'rollback';

/** Device slot identifier as reported by the device ('A' | 'B'). */
export type DeviceSlot = 'A' | 'B';

/** A parsed, signed manifest (frame[0] of ur:zafu-stream). */
export interface Manifest {
  /** semver string, e.g. "0.9.0" */
  version: string;
  /** board id, e.g. "zigner-android" */
  board: string;
  /** SHA-256 of the full image payload */
  payload_sha256: Uint8Array;
  /** payload size in bytes */
  payload_size: number;
  /** minimum acceptable current version */
  min_version: string;
  /** signing key id */
  key_id: number;
  /** signed class */
  class: FwClass;
  /** image signature (64 bytes) — field 8 of the full manifest */
  image_sig: Uint8Array;
  /** session correlation id (8 bytes) — field 9, NOT signed */
  req_id: Uint8Array;
}

/** The signed image header (fields 1..5 of the image canonical form). */
export interface ImageHeader {
  key_id: number;
  board: string;
  version: string;
  payload_sha256: Uint8Array;
  payload_len: number;
}

/** Device->wallet ur:zafu-result (device-signed durable state report). */
export interface Result {
  fw_version: string;
  success: boolean;
  slot: DeviceSlot;
  req_id: Uint8Array;
  zid_pubkey: Uint8Array;
  result_sig: Uint8Array;
}

/** Device->wallet ur:zafu-status (reconciliation report). */
export interface Status {
  fw_version: string;
  slot: DeviceSlot;
  successful_boot: boolean;
  zid_pubkey: Uint8Array;
  status_sig: Uint8Array;
}

/**
 * A device firmware record persisted by the wallet.
 *
 * IMPORTANT (spec §8): this is advisory UX state, not a trust boundary. It is
 * mutated ONLY from a device-signed, verified ur:zafu-result (`source` stays
 * 'ur:zafu-result'). Unverified claims never touch a record.
 */
export interface DeviceFwRecord {
  /** device identity (hex zid_pubkey) */
  device: string;
  /** applied firmware version */
  fw: string;
  /** slot the firmware lives in */
  slot: DeviceSlot;
  /** capability set derived from the version map */
  feature_set: string[];
  /** epoch ms the update was recorded */
  applied_at: number;
  /** provenance — only ever 'ur:zafu-result' */
  source: 'ur:zafu-result';
  /** session correlation id that produced the result */
  session: string;
}

/** Persisted session state for a single OTA push. */
export interface OtaSessionState {
  /** 8-byte correlation id (hex) */
  req_id: string;
  /** target (new) firmware version pushed */
  targetVersion: string;
  /** expected msg_id of the stream that was verified/approved */
  expectedTargetVersion: string;
  /** when the session began (epoch ms) */
  startedAt: number;
  /** timestamp the stream was last "fresh" (epoch ms) */
  lastStreamAt: number;
  /** target version for the pending update */
  pendingVersion?: string;
}

/** Wallet-side OTA state machine phase (spec §9.1). */
export enum SessionPhase {
  /** no active OTA session */
  Idle = 'idle',
  /** fetching/verifying the stream */
  Streaming = 'streaming',
  /** awaiting the human tap on the device */
  AwaitingTap = 'awaiting_tap',
  /** awaiting the device->wallet result */
  AwaitingResult = 'awaiting_result',
  /** a verified result was recorded */
  Recorded = 'recorded',
  /** an error / abort left everything untouched */
  Error = 'error',
}

/** The plain wire form of a Manifest that survives storage/transport. */
export type ManifestLike = Manifest;
