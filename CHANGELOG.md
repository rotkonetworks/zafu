# Changelog

All notable user-facing changes to the zafu extension are documented here.
This file covers the app release version (`apps/extension/package.json`
"version" / the Chrome manifest version) - not the internal package
changesets log at `apps/extension/CHANGELOG.md`, which tracks dependency
bumps for the workspace package.

## 26.0.0

Covers everything shipped since v25.0.0, including the undocumented
25.1.0/25.2.0/25.3.0 point releases, folded into this first proper
human-facing changelog entry.

### Headline: NU6.3 ironwood voting (in progress)

Zafu now ships the crypto, proving, and signing stack for Zcash's NU6.3
ironwood shielded-community voting:

- Voting support lives in its own lazy-loaded `voting-wasm` module, not
  batched into the core zafu-wasm blob, so wallets that never touch voting
  do not pay for it.
- Multithreaded halo2 proving for delegation/vote actions is routed through
  the offscreen prover with a memory-capped rayon pool, avoiding OOM on
  low-RAM devices.
- Cold (zigner) delegation is wired end to end: QR-code signing requests,
  compact response parsing, and encrypted per-round hotkey persistence.
- Hot delegation and cast, plus most of the voting UI's crypto inputs, are
  wired to the real wasm - not stubs.

Honesty note: voting is **not yet end-to-end functional in the wallet**.
The vote-commitment-tree / nullifier-IMT sync client has not been built
yet, so delegation currently fails fast with a clear error out of
`resolveRoundCommitmentRoots` / `resolveVanWitness` rather than silently
producing a bad proof. The crypto/proving/signing stack itself is proven -
on-chain delegate -> cast -> finalize has been demonstrated from Rust
drivers - but in-extension tree sync is still pending before a user can
vote from the wallet itself.

### Features

- Compact PCZT signing end to end: request, wire format (tx_type 0x05),
  and wallet-side merge against the real wasm, for both zigner and
  zafu-side signing.
- Zigner OTA firmware streaming: selectable QR density for the OTA
  dev-stream.
- ZIP-32 seed fingerprint for vizor/zigner interop.
- Ledger hardware-wallet support, scaffolded and shipped flag-off
  (`HARDWARE_WALLET_ENABLED`): WebHID transport, connect-ledger onboarding
  screen, cold-signer vaults/watch-only entries in the keyring, ledger
  signing branch fail-closed on anything that is not a V5 PCZT.
- Ironwood (NU6.3) shielding routed through the pool-correct builder, plus
  z -> t withdrawals and general ironwood sends, with network-aware
  activation height, fail-closed branch id, and ZIP-317 fee handling.
- FROST multisig sends work on ironwood. Earlier in this cycle they were
  refused post-NU6.3, and the shorthand for that ("FROST cannot sign
  ironwood") was misleading: FROST signing was never the problem, since a
  spend-auth signature over the shielded sighash is the same for an
  ironwood action as an orchard one. What was missing was on our side -
  the ironwood builder returned no sighash and no per-spend randomizers,
  so the signing rounds had nothing to run on, and there was no ironwood
  completion step to inject the aggregated signatures. Both now exist.
  Co-signer verification also derives its sighash from the transaction
  version instead of assuming v5, so what a co-signer is shown is bound to
  the message it actually signs. Honesty note: this is covered by a native
  2-of-3 test that really signs and extracts an ironwood transaction (the
  extract re-verifies the proof and every signature), and by wire-contract
  tests for the co-signer relay - but it has not yet been run against a
  live chain, so broadcast and consensus acceptance are unproven.
- Sync failure taxonomy: chain errors are classified and explained instead
  of surfacing raw internals; sync UI says what it actually knows
  (pending-tx UX, degraded rayon pool visibility, per-context truth about
  ligerito verification vs. production).
- History/balance accuracy: record what was actually sent at broadcast,
  stop counting spent notes, stop claiming "synced" early, fix display
  order to match zidecar/explorers.
- Identity/ZID: seal badge, generation name, inline rename in the drawer;
  generation rotation that actually rotates plus hanko identicons; receive
  reuse guard.
- Privacy: hide-balances eye toggle extended to every amount on the home
  screen and privacy screen; diversified addresses actually encrypted at
  rest; "clear" actually clears state.
- Contacts: offer the wallet's own zcash accounts as send recipients.
- Fees: user-configurable fee multiplier with a fingerprinting warning.
- Rotko dex surfaced as the default Penumbra dex frontend
  (dex.rotko.net), zapp tile renamed, drawer link added.
- UX/UI overhaul: washi light theme (sumi ink on unbleached paper), new
  zafu icon set with user-selectable appearance theme, simplified home
  screen, grouped settings IA, real zigner pairing screen, unified
  toggles/buttons, honest sync/balance-mask copy.
- Multisig: hot-join leave actually tears down the DKG session; streamlined
  create/join/sign flows.

### Fixes

- Security hardening across FROST co-signing after a five-lens review:
  co-signers sign only the transaction they reviewed (never the latest
  one), non-downgradeable co-sign verification, one nonce pair per alpha
  (not per session), DKG group size bound to what the user approved,
  latched/snapshotted escrow SIGN state, and commitment verification that
  fails closed on tampering.
- Compact-PCZT-signing security gaps closed in the wallet-side merge.
- FROST multisig on ironwood: refused outright earlier in this cycle, now
  supported (see Features). The refusal was correct while the builder
  returned no signing inputs - it stopped a full halo2 prove producing a
  transaction that could never be signed - but it is no longer needed.
- Ironwood witness drift recovery; active wallet identity shown correctly
  through migration.
- Ironwood change detection: stop losing the sync loop silently, stop
  claiming 100% sync prematurely.
- Sync: stop accusing a healthy server of tampering on transient errors.
- zidecar `TreeState.ironwood_tree` field-number fix (was reading field 7,
  is field 6); `blocks_until_ready` / `last_epoch_proof_height` swap fix.
- Migration: ZIP-317 fee now sums actions across both bundles; warn that
  the migrated amount becomes public.
- Four money-path release blockers on send/balance/history fixed and
  verified in a real browser smoke test against mainnet.
- Popup navigation simplified: no back-teleport, no double header, explicit
  pickers.
- Auth password gate now portals above body-level overlays; ironwood
  takeover portals above the bottom tabs.
- Zapps: fixed stale poker link (poker.zk.bot -> poker.zafu.pro), swapped
  antumbra for zechub in learn resources.
- Lint: fixed a conditional React hook and unused declarations that were
  breaking CI.
- Worker: eager-load mempool-watch imports in the zcash worker so they are
  not missed on cold start.
- zafu-wasm worker copy refresh fix (was silently stale).

### Performance

- voting-wasm lazy-loaded as its own module instead of bloating the core
  wasm bundle for every user.
- Voting/delegation proving offloaded to the offscreen prover with a
  memory-capped rayon pool.
- Sync: compact-block fetch pipelined, chain tip cached during catch-up,
  prefetch depth increased from 4 to 6.
- Rayon pool actually engaged for scanning (previously silently
  single-threaded); wasm now initialized exactly once so the pool is real.

### Security

- See "Fixes" above for the FROST co-signing hardening series - it is
  primarily a security release for multisig/poker co-signing.
- Cross-endpoint verification wired up (previously defined with zero call
  sites).
- Transparent-pool note set no longer handed to the server wholesale.

### Build

- zcash-wasm rebuilt repeatedly from upstream zcli/librustzcash as ironwood
  landed: witness support, scan speedup, `Pool` type, z->t ironwood sends,
  ironwood shielding, compact-signing wire format
  (ciphertext -> memo collapse), reconciled migrations, dropping
  fork-built blobs in favor of upstream crates.
- ledger device-kit packages added for the connect-ledger flow.
- CI: fixed the prettier gate so generated wasm glue stops breaking it.
