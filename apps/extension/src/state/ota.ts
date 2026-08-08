/**
 * Zigner firmware-OTA wallet state slice.
 *
 * Owns the wallet-side OTA ("check for update") flow and per-device firmware
 * records. Records are persisted via store.ts and are mutated ONLY from a
 * device-signed, verified ur:zafu-result.
 *
 * Flow (spec §5/§6/§9):
 *   check → verifyStream (pinned key) → Y/N approval → show ur:zafu-stream QR
 *   → scan device's ur:zafu-result → verifyResult (zid) → record (source:
 *   'ur:zafu-result'). ur:zafu-status is advisory reconciliation only.
 */

import type { AllSlices, SliceCreator } from '.';
import {
  readFirmwareRecords,
  getFirmwareRecord,
  recordVerifiedResult,
  buildRecordFromResult,
} from '../ota/store';
import { verifyStream } from '../ota/stream';
import { verifyResult, verifyStatus } from '../ota/signature';
import { decodeStrict, encodeMap } from '../ota/canonical';
import type { CborValue } from '../ota/canonical';
import { encodeStreamFrames } from '../ota/ur';
import {
  beginAwaitingTap,
  beginAwaitingResult,
  abort,
  beginStreaming,
  markRecorded,
  type OtaSession,
} from '../ota/session';
import { isUpdateApplicable, capabilitiesForVersion } from '../ota/feature';
import { OTA_FETCH_URL, PINNED_OTA_PUBLIC_KEY } from '../ota/keys';
import { hexToBytes, toHex, bytesEqual } from '../ota/util';
import { compareSemver } from '../ota/semver';
import { SessionPhase } from '../ota/types';
import type { DeviceFwRecord, Result, Status, Manifest, ImageHeader } from '../ota/types';

/** Default dev target device (corpus dev zid). Production binds a real zid. */
export const DEV_TARGET_ZID = 'a751f2ae8db37fce5fcf23ec39da2a8a94f8e3d9fb11997489be2f5603b9e207';

export interface PendingUpdate {
  manifest: Manifest;
  imageHeader: ImageHeader;
  streamFrames: string[];
  /** raw stream payload (manifest_cbor ‖ image_wrapper) — lets the UI re-fountain at a chosen density */
  payload: Uint8Array;
}

export interface OtaSlice {
  /** Verified per-device firmware records, keyed by hex zid_pubkey. */
  firmwareRecords: Record<string, DeviceFwRecord>;
  /** Active target device for OTA flows (hex zid_pubkey). */
  targetZid: string;
  /** Session state machine state. */
  session: OtaSession;
  /** A verified, pending (un-applied) update awaiting human approval. */
  pendingUpdate?: PendingUpdate;
  /** Last device-signed result (verified). */
  lastResult?: Result;
  /** Advisory reconciliation note from a ur:zafu-status scan. */
  reconciliationNote?: string;

  loadRecords: () => Promise<void>;
  setTargetZid: (zid: string) => void;
  /** Fetch + verify the stream from the dev endpoint, then gate on approval. */
  checkForUpdate: () => Promise<void>;
  /** User approved ("signed & verified — upgrade?") → show the stream QR. */
  approveUpdate: () => void;
  /** Stream shown; we now wait for the device result. */
  confirmShown: () => void;
  /** Handle a scanned ur:zafu-result (verify, then record). */
  onResultScanned: (resultBytes: Uint8Array) => Promise<void>;
  /** Handle a scanned ur:zafu-status (advisory reconciliation, no record). */
  onStatusScanned: (statusBytes: Uint8Array) => Promise<void>;
  /** Abort and leave device state untouched. */
  abortSession: (error?: string) => void;
  /** Verified record for the active target device. */
  recordForTarget: () => DeviceFwRecord | undefined;
}

function parseResultVerified(bytes: Uint8Array, zidPubkeyHex: string): Result {
  const value = decodeStrict(bytes);
  if (!(value instanceof Map)) {
    throw new Error('result is not a CBOR map');
  }
  const map = value;
  const fwVersion = map.get(1);
  const success = map.get(2);
  const slot = map.get(3);
  const reqId = map.get(4);
  const zid = map.get(5);
  const resultSig = map.get(6);
  if (
    typeof fwVersion !== 'string' ||
    typeof success !== 'boolean' ||
    typeof slot !== 'string' ||
    !(reqId instanceof Uint8Array) ||
    !(zid instanceof Uint8Array) ||
    !(resultSig instanceof Uint8Array)
  ) {
    throw new Error('malformed ur:zafu-result');
  }
  if (!bytesEqual(zid, hexToBytes(zidPubkeyHex))) {
    throw new Error('result zid_pubkey does not match target device');
  }
  // signed set = fields 1..5
  const signed: [number, CborValue][] = [
    [1, fwVersion],
    [2, success],
    [3, slot],
    [4, reqId],
    [5, zid],
  ];
  const canonical = encodeMap(signed);
  if (!verifyResult(canonical, hexToBytes(zidPubkeyHex), resultSig)) {
    throw new Error('result signature verification failed');
  }
  return {
    fw_version: fwVersion,
    success,
    slot: slot as 'A' | 'B',
    req_id: reqId,
    zid_pubkey: zid,
    result_sig: resultSig,
  };
}

function parseStatusVerified(bytes: Uint8Array, zidPubkeyHex: string): Status {
  const value = decodeStrict(bytes);
  if (!(value instanceof Map)) {
    throw new Error('status is not a CBOR map');
  }
  const map = value;
  const fwVersion = map.get(1);
  const slot = map.get(2);
  const successfulBoot = map.get(3);
  const zid = map.get(4);
  const statusSig = map.get(5);
  if (
    typeof fwVersion !== 'string' ||
    typeof slot !== 'string' ||
    typeof successfulBoot !== 'boolean' ||
    !(zid instanceof Uint8Array) ||
    !(statusSig instanceof Uint8Array)
  ) {
    throw new Error('malformed ur:zafu-status');
  }
  const signed: [number, CborValue][] = [
    [1, fwVersion],
    [2, slot],
    [3, successfulBoot],
    [4, zid],
  ];
  const canonical = encodeMap(signed);
  if (!verifyStatus(canonical, hexToBytes(zidPubkeyHex), statusSig)) {
    throw new Error('status signature verification failed');
  }
  return {
    fw_version: fwVersion,
    slot: slot as 'A' | 'B',
    successful_boot: successfulBoot,
    zid_pubkey: zid,
    status_sig: statusSig,
  };
}

export const createOtaSlice: SliceCreator<OtaSlice> = (set, get) => ({
  firmwareRecords: {},
  targetZid: DEV_TARGET_ZID,
  session: { phase: SessionPhase.Idle, startedAt: 0, lastStreamAt: 0, recorded: false },
  pendingUpdate: undefined,
  lastResult: undefined,
  reconciliationNote: undefined,

  async loadRecords() {
    const records = await readFirmwareRecords();
    set(state => {
      state.ota.firmwareRecords = records;
    });
  },

  setTargetZid(zid) {
    set(state => {
      state.ota.targetZid = zid;
    });
  },

  async checkForUpdate() {
    set(state => {
      state.ota.session = abort(state.ota.session, undefined);
    });
    try {
      const resp = await fetch(OTA_FETCH_URL);
      if (!resp.ok) {
        throw new Error(`update endpoint returned ${resp.status}`);
      }
      const data = (await resp.json()) as { payloadHex?: string };
      if (!data.payloadHex) {
        throw new Error('update endpoint returned no payloadHex');
      }
      const payloadBytes = hexToBytes(data.payloadHex);
      const { manifest, imageHeader } = verifyStream(payloadBytes, PINNED_OTA_PUBLIC_KEY);

      const current = await getFirmwareRecord(get().ota.targetZid);
      if (!isUpdateApplicable(current, manifest)) {
        throw new Error(`update ${manifest.version} is not applicable`);
      }

      const reqIdHex = toHex(manifest.req_id);
      set(state => {
        state.ota.pendingUpdate = {
          manifest,
          imageHeader,
          streamFrames: encodeStreamFrames(payloadBytes),
          payload: payloadBytes,
        };
        state.ota.session = beginStreaming(state.ota.session, reqIdHex, manifest.version);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed to check for update';
      set(state => {
        state.ota.session = abort(state.ota.session, msg);
      });
    }
  },

  approveUpdate() {
    set(state => {
      if (state.ota.pendingUpdate && state.ota.session.phase === SessionPhase.Streaming) {
        state.ota.session = beginAwaitingTap(state.ota.session);
      }
    });
  },

  confirmShown() {
    set(state => {
      if (state.ota.session.phase === SessionPhase.AwaitingTap) {
        state.ota.session = beginAwaitingResult(state.ota.session);
      }
    });
  },

  async onResultScanned(resultBytes) {
    const targetZid = get().ota.targetZid;
    try {
      if (!targetZid) {
        throw new Error('no target device');
      }
      const result = parseResultVerified(resultBytes, targetZid);
      const record = await getFirmwareRecord(targetZid);
      // Only a monotonic upgrade is recorded; a re-applied/equal version shows
      // "no update applied" (spec §7.1 monotonicity).
      if (record && compareSemver(result.fw_version, record.fw) !== 1) {
        throw new Error('no update applied (result is not an applicable upgrade)');
      }
      const newRecord = buildRecordFromResult(
        targetZid,
        result.fw_version,
        result.slot,
        capabilitiesForVersion(result.fw_version),
        toHex(result.req_id),
      );
      await recordVerifiedResult(targetZid, newRecord);
      const records = await readFirmwareRecords();
      set(state => {
        state.ota.firmwareRecords = records;
        state.ota.lastResult = result;
        state.ota.session = markRecorded(state.ota.session);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'result rejected';
      set(state => {
        state.ota.session = abort(state.ota.session, msg);
      });
    }
  },

  async onStatusScanned(statusBytes) {
    const targetZid = get().ota.targetZid;
    if (!targetZid) {
      return;
    }
    try {
      const status = parseStatusVerified(statusBytes, targetZid);
      set(state => {
        state.ota.reconciliationNote = `device on ${status.fw_version} (slot ${status.slot}, successful-boot ${status.successful_boot ? 'yes' : 'no'})`;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'status rejected';
      set(state => {
        state.ota.reconciliationNote = `reconciliation failed: ${msg}`;
      });
    }
  },

  abortSession(error) {
    set(state => {
      state.ota.session = abort(state.ota.session, error);
      state.ota.pendingUpdate = undefined;
    });
  },

  recordForTarget() {
    return get().ota.firmwareRecords[get().ota.targetZid] ?? undefined;
  },
});

/** Selector for the OTA slice. */
export const otaSelector = (state: AllSlices) => state.ota;
