/**
 * Compile-time feature flags.
 *
 * Flags gate user-facing surfaces for features whose backing infrastructure
 * (wasm exports, server RPCs, network upgrades) lands ahead of activation.
 * Code behind an OFF flag must be dormant: merged, type-checked, and
 * unreachable from the UI.
 */

/**
 * NU6.3 orchard -> ironwood turnstile migration.
 *
 * When ON, the zcash home screen shows a "migrate to ironwood" banner
 * (Zashi proposeShielding-style prompt) whenever the wallet holds orchard
 * balance, and exposes the turnstile migration flow (orchard spends ->
 * ironwood output in a single V6 transaction, cold-signed via the existing
 * PCZT QR machine).
 *
 * Default OFF until:
 * - the ironwood wasm exports ship in the deployed blob, and
 * - NU6.3 activates on the target network.
 */
export const IRONWOOD_MIGRATION = false;
