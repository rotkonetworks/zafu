/**
 * Pinned keys & policy constants for the Zafu firmware-OTA wire contract.
 *
 * Only the wallet-side verification key is pinned here (the wallet NEVER
 * signs firmware). The `ota_sign_public_key` is a dev placeholder from the
 * golden test corpus — production burn-in is out of scope (spec §11.2).
 */

import { hexToBytes } from './util';

/** Board identifier bound into every signed manifest (spec freeze doc). */
export const BOARD = 'zigner-android';

/**
 * Pinned Zafu firmware update public key (dev placeholder).
 * Ed25519, 32-byte point; source of truth: test-vectors.json
 * `ota_sign_public_key_hex`. Production uses a real HSM-derived key burned in
 * before v1 — never configure this in a release build.
 */
export const PINNED_OTA_PUBLIC_KEY_HEX =
  '89f6d7bfbdd2479083b798f61708ca80484f10c6110e6338453857a3f9e07eff';

/** Pinned key as raw bytes. */
export const PINNED_OTA_PUBLIC_KEY: Uint8Array = hexToBytes(PINNED_OTA_PUBLIC_KEY_HEX);

/**
 * Blacklisted `key_id`s. Empty in dev; a leaked key is revoked out-of-band
 * (spec §3.4) and the wallet + device both reject it.
 */
export const KEY_ID_BLACKLIST: number[] = [];

/** Whitelisted signed firmware `class` values (spec §5.2, fail-closed). */
export const CLASS_WHITELIST: readonly string[] = ['release', 'rollback'];

/**
 * Dev-only stub server URL for "check for update". Clearly dev — production
 * endpoints + real manifest URL are open items (spec §12).
 */
export const OTA_FETCH_URL = 'http://localhost:8787/zafu/ota/v1/stream';

/**
 * Maximum accepted stream payload (manifest + image wrapper) in bytes.
 * The device update is a SMALL signed protocol module (wasm), not a whole
 * firmware/kernel replacement — cap keeps the animated-QR scan to ~1-2 min
 * (spec §10: aim ≤ ~250 KB; here a generous 3 MB ceiling, fail-closed above).
 */
export const MAX_STREAM_BYTES = 3 * 1024 * 1024;

/**
 * Version -> device capability map (spec §8/§10).
 * Fail-closed: unknown/stale versions offer NO capabilities.
 */
export const CAPABILITY_MAP: Record<string, string[]> = {
  '0.9.0': ['firmware-ota', 'zid-v2'],
  '0.8.5': ['firmware-ota'],
  '0.8.0': [],
};

/** Timeout (ms) before the wallet gives up waiting for the device result. */
export const RESULT_TIMEOUT_MS = 120_000;

/** A stream is considered stale after this period without progress (ms). */
export const STREAM_STALENESS_MS = 60_000;
