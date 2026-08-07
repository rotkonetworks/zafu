
# TODO

## Features / fixes (2026-08-07)

### [DONE] cold zcash import: manual start-block (birthday) at import time
- The Zigner zcash QR (`zcash-accounts` UR) carries only the UFVK, accountIndex, label,
  and zidPublicKey — NO birthday/start block. Without it, `resolveBirthday()` in
  `hooks/zcash-auto-sync.ts:31` defaults to near the chain tip (tip-100, rounded to 10k),
  so a pre-existing cold wallet's shielded notes before that height are not detected.
- Added an optional "start block" numeric input to the zcash import (`settings-zigner.tsx`),
  validated against `ZCASH_ORCHARD_ACTIVATION` with a hint via `describeZcashHeight`.
- On add, the returned `vaultId` is captured and, if a valid start block was entered, it's
  persisted as `chrome.storage.local['zcashBirthday_<vaultId>']` (same key/module the sync
  loop reads), clamped to orchard activation. Blank = default (near tip).
- Also added: About page version (25.2.0 via chrome.runtime.getManifest) + rotko.net link.

## Error definitions / known failures

### [DONE] penumbra-wasm `computeEffectHash` tsc failure (fixed 2026-08-07)
- Error: `src/ctx/authorization.ts:14` — `Module '"@rotko/penumbra-wasm/build"' has no
  exported member 'computeEffectHash'`. It calls `computeEffectHash(fvk, plan)` to compute
  the real 64-byte effect hash for Zigner airgap signing.
- Root cause: dependency version mismatch. The root `package.json` override pins
  `@rotko/penumbra-wasm@55.0.2` (the rayon-parallel rotko fork, which provides
  `computeEffectHash`), but all 7 workspace packages declared `@rotko/penumbra-wasm: "55.0.1"`
  directly, and `pnpm install` let those direct specifiers win — so node_modules got 55.0.1,
  which lacks `computeEffectHash`. This also downgraded the lockfile to 55.0.1.
- Fix: bumped `@rotko/penumbra-wasm` 55.0.1 → 55.0.2 in all of:
  `apps/extension`, `packages/context` (peer), `packages/noble`, `packages/query`,
  `packages/storage-chrome` (dev), `packages/ui`, `packages/wallet` (dev).
  Then `pnpm install` (resolves 55.0.2) and rebuilt.
- Verified: `tsc --noEmit` exit 0, 41 files / 378 tests pass, `pnpm build` exit 0
  (the `computeEffectHash` webpack warning is gone).

### [DONE] add-zcash-wallet wasm glue mismatch (fixed 2026-08-07)
- Reported: "failed to add wallet: WebAssembly.instantiate(): Import #0 \"./zafu_wasm_bg.js\":
  module is not an object or function when adding zcash wallet now".

STATUS: FIX APPLIED 2026-08-07 (see below). Root cause confirmed and corrected.

#### Root cause (high confidence)
The zcash wasm package ships TWO different wasm-bindgen glue files that are NOT
interchangeable, but the package entry point points at the WRONG one:

- `packages/zcash-wasm/package.json`: `"main": "zcash_wasm.js"`, `"exports": { ".": "./zcash_wasm.js" }`,
  BUT `"types": "zafu_wasm.d.ts"` (types and runtime already disagree).
- The wasm binary (`zafu_wasm_bg.wasm` / `zcash_wasm_bg.wasm` — they are byte-identical,
  all copies md5 `6c43b887e73c6f2696d2cc2facb47cdc`) expects glue symbols with hash
  `__wbg_Error_92b29b0548f8b746`, `__wbg_Number_9a4e0ecb0fa16705`, etc.
- `zafu_wasm.js` (md5 `b5bb50f2…`, 124680 bytes) exports EXACTLY those symbols  -> MATCHES the binary.
- `zcash_wasm.js` (md5 `111fb270…`, 124419 bytes) exports DIFFERENT hashes
  (`__wbg_Error_83742b46f01ce22d`, `__wbg_Number_a5a435bd…`) -> DOES NOT MATCH the binary.

So any code doing `import('@repo/zcash-wasm')` resolves to `zcash_wasm.js` (the wrong glue)
and WebAssembly.instantiate against the real binary fails on import #0
(`"./zafu_wasm_bg.js"` namespace ends up not an object/function because the imported
module name in the binary doesn't resolve to what the glue provides).

Some call sites sidestep this by loading `/zafu-wasm/zafu_wasm.js` (the CORRECT glue) directly:
- `apps/extension/src/state/keyring/zcash.ts`  (initZcashWasm -> import('/zafu-wasm/zafu_wasm.js'))
- `apps/extension/src/zcash-build-parallel.ts` (offscreen prover -> import('/zafu-wasm/zafu_wasm.js'))

Call sites that hit the BUG (they `import('@repo/zcash-wasm')`, i.e. the wrong glue):
- `apps/extension/src/state/keyring/wallet-entries.ts:96` and `:172`
- `apps/extension/src/routes/popup/contacts/index.tsx:454`
- `apps/extension/src/ledger/pczt-translate.ts:176`
- `apps/extension/src/shared/components/animated-qr-scanner.tsx:220` and `:347`
(any of these during wallet add / derive will throw the import #0 error)

#### Fix applied (2026-08-07)
- `packages/zcash-wasm/package.json`: repointed `main`/`exports` (`.` → `zafu_wasm.js`,
  `./wasm` → `zafu_wasm_bg.wasm`) and `files` at the `zafu_wasm.*` that MATCHES the binary
  (was previously `zcash_wasm.*`, the stale mismatched glue). `types` was already `zafu_wasm.d.ts`.
- Refreshed the stale `zcash_wasm.js`/`zcash_wasm_bg.wasm`/`zcash_wasm.d.ts` duplicates as
  byte-identical copies of `zafu_*` (all glues md5 b5bb50f2…, all binaries md5 6c43b887…),
  restoring the BUILD_PROVENANCE invariant that `zcash_*` == `zafu_*`.
- Documented the pitfall in BUILD_PROVENANCE.md.
- Verify with: fresh `pnpm build`, then load `dist` unpacked and add a zcash wallet.

#### Candidate fixes (evaluate in order)
1. Point the package entry at the correct glue. Since the binary matches `zafu_wasm.js`
   and `types` already names `zafu_wasm.d.ts`, change `package.json`:
   `"main": "zafu_wasm.js"`, `"exports": { ".": "./zafu_wasm.js", "./wasm": "./zafu_wasm_bg.wasm" }`
   and delete/retire the stale `zcash_wasm.js` + `zcash_wasm_bg.wasm` so they cannot drift again.
   (Pick ONE source of truth per BUILD_PROVENANCE.md.)
2. If the intent is that these genuinely differ (they shouldn't), rebuild the wasm so
   `zcash_wasm.*` == `zafu_wasm.*` from the same cargo build, per BUILD_PROVENANCE.md.
3. Verify with a fresh `pnpm build`, then load `dist` unpacked and do an add-wallet.

#### Open questions / verify
- Confirm which of `zafu_wasm.js` / `zcash_wasm.js` is the authoritative, provenance-tracked glue
  (see packages/zcash-wasm/BUILD_PROVENANCE.md); align `package.json` main/exports/types to it.
- Note: `dist/zafu-wasm/zafu_wasm.js` shipped by `pnpm build` is a MINIFIED variant
  (md5 `35aab51f…`, ~47KB) that still exports the correct symbols — that copy is fine.
- Get a repro: add a zcash wallet while watching the console; confirm the failing frame
  comes from a `@repo/zcash-wasm` import (wallet-entries.ts / contacts / qr-scanner),
  not the `/zafu-wasm/zafu_wasm.js` dynamic import.

### [FIXED 2026-08-08] zcash-worker proof verification spam: "state mismatch: actions commitment mismatch: server tampered with block actions"
- Symptom: worker sync loop repeatedly logs
  `proof verification unavailable, will retry: Error: state mismatch: actions commitment
  mismatch: server tampered with block actions (computed=<c> proven=<p>)` from
  `verify_actions_commitment` (zync_core_bg.wasm), plus `peer unreachable: gRPC GetTip:
  HTTP 415`.
- ROOT CAUSE CONFIRMED (2026-08-07), see below. It is a STRUCTURAL anchoring mismatch, not the
  endpoint being down / not on-chain tampering.

#### Why the mismatch happens (confirmed from zcore source + worker)
- The actions commitment is a POSITIONAL hash chain (zcli crates/zync-core/src/actions.rs):
  `chain_i = BLAKE2b("ZYNC_actions_v1" || chain_{i-1} || actions_root_i || height_i)`, folded over
  every block from an initial seed. `verify_actions_commitment` (sync.rs:135) requires the wallet's
  running chain to EXACTLY equal the server's proven one (sync.rs:144 `running != proven` → Err).
- The wallet folds per-block from `getActionsCommitment()` → defaults to `0x00*32` (zcash-worker.ts
  :1047, :3296) and updates it per scanned block, including skips folding empty blocks with a zero
  root (zcash-worker.ts:3681/:3687).
- BUT the wallet sync starts at `currentHeight = max(startHeight ?? 0, syncedHeight)` (zcash-worker.ts
  :3064) — i.e. a birthday / import start block, NOT genesis. This wallet runs from height
  2,910,104. The server's proven `final_actions_commitment` (from the header proof / prover.rs) is
  anchored to the cumulative value BEFORE that birthday.
- Because the fold includes `chain_{i-1}`, seeding it with 0x00*32 at height 2,910,104 instead of the
  accumulated value entering that height makes the wallet's first block commitment differ from the
  server's, and EVERY subsequent height differs too. => PERMANENT mismatch, retries forever. The
  wallet never re-anchors its running commitment to the proven value: the RSA return value of
  `verify_actions_commitment` at zcash-worker.ts:1372 is discarded and never saved as running
  (the legacy-wallet adoption in sync.rs:140-143 is effectively dead for the worker).
- The worker's tampering classifier (zcash-worker.ts:3560-3574) does NOT match "actions commitment
  mismatch", so it's downgraded to a benign "will retry" warn — correct for availability, but it
  means the check can neither fail safe nor actually detect a lying server. That's the real design
  gap: the wallet and server are not guaranteed to fold the same domain, so equality is
  unprovable-by-construction for any non-genesis/birthday wallet.
- Secondary candidates that also break the chain (same class): a per-block actions root not yet
  backfilled by the indexer when the header proof is taken ("indexer still filling", see comment at
  zcash-worker.ts:3550), or an off-by-one on empty-vs-non-empty block roots.
- Fix directions (choose one): (a) anchor the wallet's running commitment to the proven value at the
  birthday before folding (seed `running = proven` at import/start), or (b) only assert equality
  over the RANGE the wallet actually scanned from the server's accumulated value, or (c) require the
  server to expose a commitment rooted at the same start height the wallet uses. Until then, drop or
  gate the check for non-genesis-start wallets so it no longer spams.
- Note: `peer unreachable: gRPC GetTip: HTTP 415` is a SEPARATE symptom (endpoint not serving gRPC),
  unrelated to the commitment check.
- FIX APPLIED (2026-08-08): gated the verify_actions_commitment call on the wallet actually being
  genesis-anchored. verifySyncProofs gained a `genesisAnchoredActions` param; runSync sets it to
  `(startHeight ?? 0) === 0`. For non-genesis wallets (nearly all — default start is near tip) the
  check is skipped with a one-line warn explaining the fold is not genesis-anchored, so the spam
  loop stops. It is still verified for genuine genesis wallets, where it is sound. The sound,
  single-instant checks (nullifier/commitment proofs) are unaffected. Files: zcash-worker.ts (three
  edits). tsc 0, 378 tests pass, eslint 0.
- UPSTREAM REFERENCE / PREFERRED FIX (2026-08-08, from Vizor — user directive: use upstream ECC libs
  whenever possible): Vizor does NOT do this wallet-verified positional actions-commitment fold at all.
  It delegates to the ECC SDK: download Sapling/Orchard subtree roots from lightwalletd via
  `put_*_subtree_roots` (genesis-anchored from subtree index 0) and `scan_cached_blocks` with a
  canonical tree-state anchor per batch; a commitment-tree-root conflict is treated as a reorg/rewind
  (continuity), and anchor-root mismatches are repaired against lightwalletd `get_tree_state` with
  escalating rewinds. Commitment verification anchors at GENESIS; note scanning starts at the birthday.
  See vizor rust/src/wallet/sync_engine/lwd.rs:331-498 and mod.rs:2030-2118,945-1122. Recommended for
  Zafu: drop the custom `zync-core verify_actions_commitment` chain check (it cannot be anchored
  soundly for a birthday wallet) and adopt the upstream subtree-root/genesis-anchored model, or at
  minimum gate/disable the check for non-genesis-start wallets until zcash-wasm can do the upstream
  anchoring.

### [FIXED 2026-08-08] balance showed 0 in all pools while a spend was unconfirmed
- RESOLUTION (2026-08-07, original): once the send confirmed at block 3,439,270 the balance corrected to
  0.0024 ZEC. No funds lost. Root cause = pending-send accounting: spendable = confirmed notes
  minus notes reserved by pending sends, and the unconfirmed send's CHANGE note is NOT credited
  until it mines. Timeline: 0.00355 receive (#3436921) → spent by 0.00065 send (#3437366, change
  0.0029) → that 0.0029 spent by the 0.0005 send → change 0.0024 stayed invisible until confirm.
  During the mempool window every pool showed 0 and the empty-state "get your first zec" banner
  appeared although ~0.0024 was in flight.
- FIX APPLIED (2026-08-08): added a pending shielded-change bucket (upstream
  change_pending_confirmation). getPoolBalances now also returns pendingOrchard/pendingIronwood/
  pendingTotal = for each unconfirmed (SentTxRecord without confirmedHeight) send whose inputs are
  marked spent locally (spent_by_txid) but not yet seen on chain (no spent_at_height): change =
  inputs − amount (amount includes fee). This is NOT added to spendable (sends still gate on
  spendable) but IS surfaced:
  - hero figure totalZat now includes pools.pendingTotal, so a pending send no longer renders "0
    ZEC in all pools" — ironwood (the active NU6.3 pool) change stays visible.
  - a "pending" row (badge "change · confirming") is added to the pool breakdown when pendingTotal>0.
  - the "get your first zec" empty-state now requires totalZat===0 AND inFlightZat===0, so it no
    longer fires while a send is in flight.
  Files: zcash-worker.ts (getPoolBalances), network-worker.ts, hooks/zcash-pool-balances.ts,
  routes/popup/home/index.tsx. tsc 0, 378 tests pass, eslint 0.
- Still-open (upstream gap): value_pending_spendability (received-but-unconfirmed value) is not
  tracked separately — only our own change is. Adopting the ECC AccountBalance model fully (per
  TODO note below) would add it; not required for the reported bug.
- UPSTREAM REFERENCE (2026-08-08, from Zashi + Vizor — both run the ECC SDK): the correct model is
  zcash_client_backend `AccountBalance`: spendable_value (confirmed, gating `canSpend`) + a SEPARATE
  pending bucket `change_pending_confirmation` (your change from unconfirmed sent txs, NOT spendable
  until ZIP-315 confs — 3 trusted / 10 untrusted) + `value_pending_spendability`, with
  total = spendable + changePending + valuePending. Input nullifiers are marked spent at send time,
  but change is credited to TOTAL immediately and shown as its own "Pending" row (spinner) whenever
  total > spendable and a pending tx exists (Zashi SpendableBalanceVM.kt:74-77,119-149; WalletAccount.
  kt:26 `pending = changePending + valuePending`; rust src/rust/src/wallet/sync/transactions.rs:123-196
  & zcash_client_sqlite/src/wallet.rs:2719-2759 that implies the same — both wallets show TOTAL as the
  headline incl. pending, and gate sends on spendable). Zafu should mirror this: keep unconfirmed
  outputs visible as pending/total immediately, don't drop to 0, gate the "get your first zec" empty
  state on total==0 not spendable==0.

### [OPEN] balance shows 0 ZEC in all pools while a spend is stuck unconfirmed
- Address (unified): u1e3j0kl74frk2ae2ascjextned588xscssgrmk8zfy0muz9xywtcs0zcmys3clzlmxyryepk8qar3252jenx3caw42ef79mj8gcqtrhz2
- Repro: held 0.003 ZEC (received via tx d2a2e1fbc18b0c7a..., note at height #3436921). Sent dust
  0.0005 ZEC (tx 93ec85b8d7e695e1..., today 01:59 PM): 0.0004 sent + 0.0001 fee. That tx is now
  stuck UNCONFIRMED ("0.0005 ZEC leaving · not yet confirmed").
- Symptom: sync shows tip 3,439,269 / 3,439,269 fully scanned (nomt ✓, ligerito ✓, scanning notes ✓),
  yet all three pools render 0 ZEC — ironwood/orchard 0, legacy/orchard 0, transparent/public 0 —
  and the empty-state "get your first zec" banner shows even though ~0.0024 ZEC (0.003 − 0.0006)
  should still be there.
- Expected: pools should show ~0.0024 ZEC net of the pending spend, OR the spend note should not
  zero out the balance while unconfirmed. Getting 0 across every pool (including the unspent
  remainder) is wrong.
- Investigate: balance/summaries computation around unconfirmed (pending) spending notes — likely
  the outgoing send's notes are being marked spent and subtracted, but its change/orchard outputs
  and the remaining unspent notes aren't being counted, so the available sum collapses to 0.
  Compare confirmed-vs-pending balance paths: how `0.00355 received` (from #3436921) was counted vs
  how the pending `0.0005 sending` is being subtracted. Look at packages/query + extension
  balance hooks / zcash summary code. Possibly an over-subtraction (fee counted twice, or note
  nullifier spent by pending tx dropping value while output notes pending aren't added).
- Status: NOT fixed, needs repro + trace. Flag for a deeper agent pass.

### proof-of-build artifacts (as of last full build)
- `pnpm install` exit 0; `pnpm build` exit 0 (`Tasks: 1 successful`, ~2m27s).
- Outputs: `apps/extension/dist` (194M) and `apps/extension/beta-dist` (194M),
  both `manifest.json` version 25.2.0.
