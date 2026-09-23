# Changelog

All notable user-facing changes to the zafu extension are documented here.
This file covers the app release version (`apps/extension/package.json`
"version" / the Chrome manifest version) - not the internal package
changesets log at `apps/extension/CHANGELOG.md`, which tracks dependency
bumps for the workspace package.

## 28.2.0

Covers everything since 28.0.4. Focus: the side panel stays put, a reorganized
settings surface, and Injective endpoint control - plus wallet-management and
reliability fixes.

### Side panel stays open

- In side-panel mode, connecting a dapp now opens the side panel directly (using
  the connect click as the gesture) instead of falling back to a popup window,
  and the panel stays on the wallet home after you approve a transaction. This
  ends the behavior where the sidebar turned into popups after the first
  approval.
- Airgap (Zigner) approvals always open in a full window, where the QR codes
  fit. The surface (side panel vs window) is the wallet's decision, not the
  app's, so the experience stays consistent across apps.
- An open side panel is detected reliably, so approvals stop opening a separate
  window when the panel is already there.

### Settings, reorganized

- One "Wallets & Networks" tab, and a dedicated "Security & Backup" hub that
  gathers the recovery passphrase, auto-lock, and "resync state" (formerly
  "clear cache").
- Each wallet has an actions menu - rename, export recovery phrase, or remove.
  Recovering the same seed no longer creates duplicate wallet entries, and an
  un-decryptable vault can now be removed.
- Penumbra node selection is registry-backed with latency probes, and each
  network remembers your endpoint-selection strategy.
- The transaction-signing control moved from Privacy to Security, and "act as
  Keplr" moved from Privacy to the Penumbra network settings.

### Cosmos and Injective

- Injective now has a user-editable RPC endpoint pool (a burner subnetwork under
  Penumbra); balance and subwallet reads rotate across it, like Noble, so no
  single provider can link your burner addresses.
- Withdrawing to Noble or Injective offers your own wallet as the destination,
  with a max-amount shortcut.
- Burner addresses rotate: a fresh chain address per use, rate-limited.

### Reliability

- The network worker no longer errors "worker not ready" when a call arrives
  during startup - for example a Zigner cold-wallet sync. It waits for the
  worker to come up instead of failing.
- LP NFTs and other synthetic tokens are hidden from asset pickers.
- Per-asset Send/Swap quick actions on the home screen, pre-selecting the asset.
- Camera/QR permission handling is reliable in Brave, without a grant-tab loop.

## 28.0.4

Covers everything since 28.0.3. Focus: assets show their real names and icons
(Injective funds included), plus smoother Zcash onboarding and Injective flows.

### Assets show real names and icons

- Balances, send, swap and receive now render each asset's registry symbol and
  icon instead of a raw denom path, with a clean monogram fallback when no icon
  is known. A raw `passet1…` / `transfer/channel-…` path is never shown to the
  user as an asset name.
- The chain/asset registry now comes from the maintained `@penumbrafi/registry`
  (the former `@penumbra-labs/registry` is unmaintained). This carries the full
  Injective (channel-18) asset set, so USDC.inj, INJ and the other Injective
  denoms resolve to proper names instead of "Unknown asset".

### Injective panel, more honest and usable

- Live balance with periodic refresh, max-amount buttons, an INJ gas-fee gate,
  a truthful submitted -> confirmed status flow (only advances once the tx is
  actually on-chain), block-explorer links, and bech32 address validation.

### Zcash onboarding, smoother

- Guided import flow - recovery phrase, review, birthday, password - with a
  reused date picker for the birthday and a safe birthday floor (unknown
  birthdays fall back to Orchard activation rather than a from-tip scan).

## 28.0.1

Covers everything since 28.0.0.

### Injective USDC ramp (replaces the sunsetting Noble path)

- Receive Circle-native USDC (USDC.inj) on Injective and shield it into Penumbra
  over the live IBC channel, or withdraw it back to an exchange - a dedicated
  in-wallet panel. Injective is Ethermint (eth_secp256k1 / coin type 60), so it
  derives and signs on its own path, never the shared cosmos one.
- The old "on-ramp USDC to Noble" copy is gone; Noble shows a deprecation notice.

### Onboarding, simplified

- First run defaults to Zcash-only and drops the network-select screen; enable
  more networks later in Settings. The Zcash birthday folds into set-password.

### Post-quantum encryption (harvest-now-decrypt-later)

- The encrypted messaging channel and the app-facing sealed box are now hybrid
  X25519 + ML-KEM-768: traffic recorded today stays confidential against a
  future quantum computer. Message content is protected end to end; signatures
  and identity stay classical (no harvest-now exposure there).

### Developer SDK (new npm packages)

- `@zafu/zid` (plus `@zafu/protocol` and `@zafu/pq`): let a website offer
  "log in with zafu", sign, and send post-quantum-encrypted messages without
  ever handling a private key.

### Reliability and security

- Fixed a startup render-loop crash and several teardown leaks introduced by the
  React 19 / router 7 / zustand 5 framework upgrades, and an HD key-derivation
  regression from @noble/hashes 1.8.
- Pre-merge security hardening: authenticate the peer on the encrypted-channel
  responder; enforce the Keplr-compatibility opt-out on the request path (not
  just install); guard the dapp API against third-party-iframe approval spoofing,
  stale capability grants after revocation, and oversized messages; and keep
  Ethermint chains (Injective) off the coin-118 derivation path everywhere.

## 28.0.0

Covers everything since 27.3.2. Major bump: the address book is now a
wallet-held social graph with private contact discovery and in-wallet
messaging, and the release rides breaking framework upgrades.

### Headline: private contact discovery and in-wallet messaging

- Contacts are anchored to ZIDs (identities), not just addresses - a person
  is a name, an identity, and where to find them, of which their chain
  addresses are one part. Address-only contacts still work and can be linked
  to a ZID later.
- Private contact discovery over a blind relay: two people who already know
  each other compute a per-epoch rendezvous tag with zero communication and
  find each other's presence without handing the relay the metadata to
  rebuild a social graph. Reads fetch a whole bucket (never a per-friend
  query) and publishes are fixed-size padded batches, so neither who you look
  up nor how many friends you have is observable.
- Multisig group chat: every multisig group gets a coordination thread in the
  inbox, carried over a dedicated frostd session with end-to-end sealed
  frames. Messages queue for an offline co-signer and are readable when they
  return.

### zcash.me directory (opt-in, default off)

- Look up and pay `/username`, and label addresses from the public zcash.me
  directory. Off by default; both directory-snapshot and live-lookup modes
  explain exactly what zcash.me learns before you enable them.
- Live lookups can be covered by decoy names so zcash.me cannot tell which
  name you wanted; cover no longer degrades silently when unavailable.
- Reverse-labelling an address is verified-only: an unverified profile can
  claim any address, so it is never used to name one (anti-spoofing).

### Multisig

- frostd relay transport with number-plus-two-word room codes for DKG and
  signing, replacing the bespoke relay; relay traffic is sealed end to end.
- Fresh 2-of-3 wallets can sign: the co-signers' relay keys and the DKG
  transport identity are now persisted, so signing reuses the whitelisted
  identity instead of a mismatched one.

### Fixes

- Keplr: the approval popup now delivers its result before closing, so
  connecting no longer hangs after you accept.
- Keplr compatibility is now opt-in (a new "act as keplr" toggle in privacy
  settings, off by default). Previously zafu injected `window.keplr`
  unconditionally and could clobber a user's real Keplr; now it never touches
  the slot unless you turn compatibility on, and even then defers to a real
  Keplr if one is present.
- Noble: a warning now tells holders that Circle is winding down USDC and CCTP
  on Noble - the bridge halts Dec 1, 2026 and the Noble USDC contract pauses on
  Jan 12, 2027 - and to move their USDC off Noble (and sell or hold it
  elsewhere) before then.

### Removed

- License checks. The unfinished pro-license feature pinged an external
  server on every unlock (an IP and "uses zafu" leak on the critical path)
  for no user benefit yet; removed until it ships behind an anonymous check.

### Under the hood

- React 18 to 19, react-router 6 to 7, zustand 4 to 5, and other major
  dependency upgrades.

## 27.3.2

### Fixes

- Penumbra RPC: when Penumbra is disabled or not the active network, dapp
  requests failed with an opaque "Cannot read properties of undefined
  (reading 'fullViewingKey')" error. The service worker was caching the
  `wallet: undefined` stub from `startWalletServices` as the "ready"
  wallet. The wallet cache now rejects with the stub's reason instead, so
  dapps see `penumbra network not active` / `penumbra network not enabled`.

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
