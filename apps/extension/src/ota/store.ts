/**
 * Persistence for per-device firmware records (spec §8).
 *
 * Records are keyed by hex `zid_pubkey` and stored via `localExtStorage`
 * (@repo/storage-chrome/local, LocalStorageState.zignerFirmwareRecords).
 *
 * INVARIANT: a record is mutated ONLY from a device-signed, VERIFIED
 * `ur:zafu-result`. The verification itself (verifyResult) happens in the
 * caller before it invokes {@link recordVerifiedResult}; this module only
 * persists the resulting record and never fabricates state.
 */

import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import type { DeviceFwRecord } from './types';

/** Storage key in LocalStorageState. */
export const FIRMWARE_RECORDS_KEY = 'zignerFirmwareRecords';

type StoredRecords = NonNullable<LocalStorageState['zignerFirmwareRecords']>;

/** Read all verified device records (empty map when none). */
export async function readFirmwareRecords(): Promise<Record<string, DeviceFwRecord>> {
  const stored = await localExtStorage.get(FIRMWARE_RECORDS_KEY);
  return (stored ?? {}) as Record<string, DeviceFwRecord>;
}

/** Read a single device's verified record, or undefined. */
export async function getFirmwareRecord(zidPubkeyHex: string): Promise<DeviceFwRecord | undefined> {
  const records = await readFirmwareRecords();
  return records[zidPubkeyHex];
}

/**
 * Persist a device-signed, verified `ur:zafu-result` as a firmware record.
 *
 * Caller MUST have verified `result_sig` against `zid_pubkey` (see
 * signature.verifyResult) before calling — this module does not re-verify and
 * records exactly what it is told.
 */
export async function recordVerifiedResult(
  zidPubkeyHex: string,
  record: DeviceFwRecord,
): Promise<void> {
  const records = await readFirmwareRecords();
  records[zidPubkeyHex] = record;
  await localExtStorage.set(FIRMWARE_RECORDS_KEY, records as StoredRecords);
}

/** Remove a device's record (e.g. device removed from the wallet). */
export async function removeFirmwareRecord(zidPubkeyHex: string): Promise<void> {
  const records = await readFirmwareRecords();
  if (!(zidPubkeyHex in records)) {
    return;
  }
  delete records[zidPubkeyHex];
  await localExtStorage.set(FIRMWARE_RECORDS_KEY, records as StoredRecords);
}

/**
 * Build a {@link DeviceFwRecord} from a verified result. `source` is always
 * 'ur:zafu-result' and `session` is the correlation req_id that produced it.
 */
export function buildRecordFromResult(
  zidPubkeyHex: string,
  fwVersion: string,
  slot: 'A' | 'B',
  featureSet: string[],
  sessionReqIdHex: string,
): DeviceFwRecord {
  return {
    device: zidPubkeyHex,
    fw: fwVersion,
    slot,
    feature_set: featureSet,
    applied_at: Date.now(),
    source: 'ur:zafu-result',
    session: sessionReqIdHex,
  };
}
