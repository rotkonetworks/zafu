/**
 * Wallet-side feature gating for device firmware (spec §8/§10, fail-closed).
 *
 * Capabilities are derived from a version -> capabilities map. Unknown or
 * stale versions offer NO capabilities — never assume. This is advisory UX
 * routing only; the device enforces the true trust boundary.
 */

import { CAPABILITY_MAP } from './keys';
import { compareSemver, isValidSemver } from './semver';
import type { DeviceFwRecord, Manifest } from './types';

/**
 * Capability set offered for a device firmware version.
 *
 * @returns the capability list, or [] for unknown/stale/invalid versions.
 */
export function capabilitiesForVersion(version: string): string[] {
  if (!isValidSemver(version)) {
    return [];
  }
  return CAPABILITY_MAP[version] ?? [];
}

/**
 * Whether a verified record 'has' a capability. A missing/stale record never
 * claims capabilities.
 */
export function hasCapability(record: DeviceFwRecord | undefined, capability: string): boolean {
  return Boolean(record?.feature_set.includes(capability));
}

/**
 * Whether an incoming verified manifest is applicable to the current device
 * record — i.e. it is a strict monotonic upgrade of the applied firmware.
 *
 * - no record → applicable (first install / fresh device)
 * - manifest.version > record.fw → applicable
 * - manifest.version <= record.fw → NOT applicable (no re-apply / no
 *   downgrade on the wire; rollback is a device-local, user-tapped menu action)
 *
 * @returns true when the wallet should offer the update.
 */
export function isUpdateApplicable(
  record: DeviceFwRecord | undefined,
  manifest: Manifest,
): boolean {
  if (!record) {
    return true;
  }
  const order = compareSemver(manifest.version, record.fw);
  if (order === null) {
    // invalid semver — fail closed
    return false;
  }
  return order > 0;
}
