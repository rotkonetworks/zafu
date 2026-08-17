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
 * Send the airgapped signing REQUEST in the compact form (zigner envelope
 * tx_type 0x05) instead of the legacy full-PCZT form (0x03).
 *
 * A compact request ships a further-redacted PCZT — cv_net, the v6 bundle
 * anchors and the output cmx are dropped, and each output's 580-byte
 * enc_ciphertext collapses to its memo trimmed to the last nonzero byte (one
 * byte for the empty memo a migration uses). The device recomputes all of it
 * in `resolve_fields()` before running the SAME verification gates, so nothing
 * is trusted that was not proven; upstream measured ~2.7x less request payload
 * on a 35-transaction migration.
 *
 * COMPATIBILITY: a zigner older than v0.8.2 does not know tx_type 0x05 and
 * fail-closes on the unknown prelude. The device also answers a compact
 * request with a compact (signatures-only) response, which needs the
 * `apply_signature_contributions` wasm export — present since the zcli
 * 70722f7 wasm rebuild. Turn this OFF to fall back to the fully
 * backward-compatible 0x03 request and full-PCZT response.
 */
// OFF pending a zafu-wasm rebuild. redact_pczt_compact (zcli) clears cv_net on
// a PCZT whose spend.value was already stripped by redact_pczt_for_signer, so
// the device's resolve_cv_net cannot rebuild cv_net and rejects an ironwood
// sign with ParseError::InvalidValueCommitment. The fix (stop clearing cv_net)
// is committed in zcli but not yet in the vendored wasm blob; until the blob is
// rebuilt we send the full signer-redacted PCZT (cv_net retained, spend.value
// still stripped for privacy) for the only two compact users - ironwood send +
// turnstile migration. Orchard never used compact. Restore to true once the
// rebuilt blob ships (small compact QR returns then).
export const COMPACT_SIGN_REQUEST = false;

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

/**
 * Ledger TRANSPARENT support via the legacy Bitcoin-app path (@ledgerhq/hw-app-btc),
 * separate from HARDWARE_WALLET_ENABLED above (which gates the DMK shielded path
 * that is blocked on LedgerHQ's unreleased NU6.3 app). The Bitcoin-app path signs
 * transparent Zcash on mainnet TODAY - it is how a Ledger holder can send/receive
 * t-address ZEC in zafu and migrate over.
 *
 * ENABLED experimentally (no real users yet - see the growth rationale: other
 * wallets' Ledger support is currently broken). The money-path specifics in
 * src/ledger/hw-btc-signer.ts (expiry buffer / v5 prev-tx parsing / sighash) are
 * asserted from the hw-app-btc types but NOT yet confirmed against a physical
 * device signing a real mainnet t->t tx. Worst case of a wrong assumption is a
 * REJECTED tx (funds safe), and Erwan's plan refuses to burn change to fee. The
 * device test is what hardens this from experimental to production-trusted.
 */
export const LEDGER_TRANSPARENT_ENABLED = true;
