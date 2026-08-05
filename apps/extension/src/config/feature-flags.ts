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
 * Shipped ON (guard-protected): the ironwood wasm exports are in the deployed
 * blob and the flow is fully reviewed. Before NU6.3 activates, the migration
 * is fail-closed at build time - the worker fetches consensus_branch_id from
 * GetLightdInfo and the producer REFUSES to build unless the bound branch id
 * equals the real NU6.3 value (0x37a5165b), so the migrate action shows a
 * clean "NU6.3 not active yet" error rather than producing an invalid tx.
 * This avoids a second store cycle to enable migration at activation.
 */
export const IRONWOOD_MIGRATION = true;

/**
 * NU6.3 Ironwood mainnet activation height.
 *
 * Confirmed and tagged by Zcash core (Sean Bowe): block 3,428,143,
 * approximately 2026-07-28 13:00 UTC (8AM EST). At this height the tip's
 * consensus branch id becomes the real NU6.3 value (0x37a5165b) and
 * orchard-to-orchard sends are disabled - the one-way turnstile is the only
 * way to keep spending orchard funds from here on.
 *
 * The migrate-to-ironwood surfaces stay hidden until the synced chain tip
 * reaches this height, so the prompt "activates on the upgrade date" rather
 * than nagging early. The build-time producer still fail-closes on the branch
 * id independently (see IRONWOOD_MIGRATION), so this gate is UX, not safety.
 */
export const NU6_3_ACTIVATION_HEIGHT = 3_428_143;

/**
 * Deterministic password generator (identity -> passwords: derive a site
 * password from seed + site + username). Disabled for now - the feature and
 * its route stay in the codebase, just unreachable from the UI. Flip back to
 * `true` to re-enable.
 */
export const PASSWORD_GENERATOR = false;

/**
 * Pro subscription upsell surface. Hidden for now - the subscribe route and
 * pro-gating logic stay in the codebase, just unreachable from the settings
 * list and the drawer "upgrade" button. Flip back to `true` to re-enable.
 */
export const SUBSCRIBE_ENABLED = false;

/**
 * Ledger hardware-wallet support (WebHID connect + shielded/transparent
 * account import). Hidden for now - the onboarding "connect Ledger" card, its
 * route, and the connect screen stay in the codebase, just unreachable from the
 * UI. The backing pieces (the `src/ledger` WebHID module and the keyring's
 * `addLedgerUnencrypted`) land ahead of activation; flip to `true` once the
 * Ledger zcash app version we target ships and the flow is fully reviewed.
 */
export const HARDWARE_WALLET_ENABLED = false;
