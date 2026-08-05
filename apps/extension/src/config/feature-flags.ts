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
 * NU6.3 Ironwood activation height on MAINNET.
 *
 * Confirmed and tagged by Zcash core (Sean Bowe): block 3,428,143,
 * approximately 2026-07-28 13:00 UTC (8AM EST). At this height the tip's
 * consensus branch id becomes the real NU6.3 value (0x37a5165b) and
 * orchard-to-orchard sends are disabled - the one-way turnstile is the only
 * way to keep spending orchard funds from here on.
 */
export const NU6_3_ACTIVATION_HEIGHT_MAINNET = 3_428_143;

/**
 * NU6.3 Ironwood activation height on TESTNET.
 *
 * The pinned librustzcash fork activates NU6.3 at height 1 on test/regtest
 * (see `zcash_protocol::consensus`, and `nu6_3_activation_height(false) == 1`
 * on the Rust side), i.e. testnet is ALWAYS post-activation.
 */
export const NU6_3_ACTIVATION_HEIGHT_TESTNET = 1;

/**
 * The NU6.3 activation height for the network the wallet is talking to.
 *
 * MUST be used instead of a bare constant. The height was previously
 * mainnet-only but applied network-independently, so on testnet a send saw
 * `tip < 3_428_143` and picked the ORCHARD pool while
 * `build_shielding_transaction_auto` (network-aware in Rust) picked IRONWOOD -
 * the two halves of the wallet disagreed about which pool was live on the same
 * chain, and the orchard side built transactions the testnet node rejects.
 *
 * This gate is UX/pool-selection. The wasm producers independently fail closed
 * on the live consensus branch id (see IRONWOOD_MIGRATION), so a wrong answer
 * here surfaces as a clean refusal rather than an invalid broadcast.
 */
export const nu63ActivationHeight = (mainnet: boolean): number =>
  mainnet ? NU6_3_ACTIVATION_HEIGHT_MAINNET : NU6_3_ACTIVATION_HEIGHT_TESTNET;

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
