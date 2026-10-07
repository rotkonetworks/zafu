# zcash-wasm build provenance

## ⚠ TWO consumers — refresh BOTH of them

A rebuild that updates only some copies ships a wallet whose worker and
prover disagree. This has bitten twice:

| path                               | loaded by                 | symptom when stale                                                                       |
| ---------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/zcash-wasm/` (`zafu_*`)  | build-time package import | type/API drift; missing exports (e.g. shielding)                                         |
| `apps/extension/public/zafu-wasm/` | the main compute worker   | `X.compute_txid is not a function`; silently rebuilds txs with an old consensus constant |

⚠ 2026-08-07: a stale `zcash_*` duplicate in `packages/zcash-wasm/` once broke
`import('@repo/zcash-wasm')`. The duplicates are gone; the package `main`/`exports`
point at `zafu_wasm.js`, and both copies above must stay byte-identical.

Both `public/` copies are the PARALLEL build (rayon `snippets/`, shared
memory). After copying either one, re-apply the Chrome worker patch and
verify `wbgRayonBase` is BOTH defined and used in
`snippets/*/src/workerHelpers.js` — patching only the call site leaves an
undefined reference that kills sub-workers silently.

Finally: `pnpm build` (NOT `pnpm bundle:prod`) so `dist/` and `beta-dist/`
both pick the new blobs up, then grep a known-new symbol in each.

These vendored .wasm blobs are build artifacts. Do NOT hand-edit.

**Which build is shipped: see the newest dated entry below** (zafu-wasm:
the first `## <date> rebuild` section; voting-wasm: the first `###` entry
under its own section). Each entry names the zcli repo, branch and rev, the
toolchain, and the sha256 of every shipped file. Verify by checking out that
rev, running the recipe, and comparing sha256sums; a mismatch means the
vendored blob is stale. Nothing above the dated entries names a rev or a hash.

Only the PARALLEL zafu-wasm build ships, copied to both
`packages/zcash-wasm/` and `apps/extension/public/zafu-wasm/` (glue, `.d.ts`,
`_bg.wasm`, `_bg.wasm.d.ts`). There is no single-thread blob and no
`zafu-wasm-parallel/` directory any more.

## recipe: zafu-wasm, parallel / rayon

    # DO NOT set RUSTFLAGS - the env var overrides the workspace
    # .cargo/config.toml rustflags wholesale, which drops the link-args
    # (--shared-memory, --import-memory, --max-memory, --export=__wasm_init_tls...).
    # Without them the output has a private non-shared memory, rayon
    # postMessage to sub-workers throws DataCloneError, and halo2 proving
    # is dead on the mnemonic-send path.
    cd crates/zcash-wasm
    unset RUSTFLAGS
    RUSTUP_TOOLCHAIN=nightly cargo wasm-parallel
    wasm-bindgen ../../target/wasm32-unknown-unknown/release/zafu_wasm.wasm \
      --out-dir pkg-parallel --target web
    wasm-opt -Oz --enable-threads --enable-bulk-memory --enable-simd \
      --enable-mutable-globals --enable-nontrapping-float-to-int \
      pkg-parallel/zafu_wasm_bg.wasm -o pkg-parallel/zafu_wasm_bg.wasm

Toolchain: nightly rustc, wasm-bindgen CLI and binaryen as the entry says
(binaryen 130 at
`/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130`; `-Oz` output
differs byte-wise between binaryen versions).

Verify the rebuilt blob has shared imported memory before shipping:
`(import "./zafu_wasm_bg.js" "memory" (memory ... shared))` post-bindgen.

After copying, keep the LOCAL PATCH in
`snippets/wasm-bindgen-rayon-*/src/workerHelpers.js` (stock
`await import('../../..')` is a directory import that Chrome extensions
reject; it is replaced with the concrete `zafu_wasm.js` URL). While the
snippet hash is unchanged the patched file is kept as is.

## voting-wasm (apps/extension/public/voting-wasm/) - separate blob

The shielded-voting module ships as its own blob, lazy-loaded by
`state/voting-wasm.ts` (light calls) and the offscreen prover
(`zcash-build-parallel.ts`, proofs). It is NOT built from `crates/zcash-wasm`;
refreshing zafu-wasm leaves it untouched, and vice versa.

### 2026-10-05 (2) - post-merge review fixes

- source repo: zcli, branch `master`, rev `82d67b5` (the merge of
  `fix/voting-review` 2359748, PR #20; its tree is identical to 2359748's).
  Rebuilt from `82d67b5` on 2026-10-05 with the recipe below: all three
  shas match byte for byte, so the shipped blob is a master build.
  (2359748 is 2e50b9c plus the review nits: `cast_vote_hot` no longer builds
  share payloads at all): crate `crates/voting-wasm`, `--features parallel`, built with
  `crates/voting-wasm/build-wasm.sh` (which now runs the `wasm-opt` step
  below and both local patches itself).
- why: `cast_vote_hot_wire` returned helper shares built from a guessed tree
  position (`vc_tree_position` is only known once the cast is included), so
  sending them dropped the vote from the tally. A testnet snapshot past NU7
  (4,465,026) failed at PCZT build with a misleading branch mismatch.
- exports: `cast_vote_hot_wire` returns `{ proposal_id, wire,
commitment_bundle_json, next_delegation_state_json }` (no `shares`) and
  takes no `submit_at`; `build_vote_shares_wire` is gone, so
  `build_vote_shares_from_recovery` is the only share path;
  `selftest_prove_delegation` is no longer in release blobs (zcli
  `--features parallel,selftest` for a timing build). `build_delegation_pczt`
  accepts any branch with the Ironwood pool (NU6.3, NU7) and always builds
  under TX1 v1's V6 / NU6.3 profile. The rest is unchanged.
- new file `wait_async_worker.js`: where `Atomics.waitAsync` is missing
  (Firefox) js-sys's futures executor waits through a helper worker. The
  stock glue starts it from a blob: URL, which the extension CSP refuses; the
  glue now loads this shipped copy of the same script instead.
- recipe (RUSTFLAGS unset):

      CARGO_TARGET_DIR=... WASM_OPT=/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130/bin/wasm-opt \
        crates/voting-wasm/build-wasm.sh <out dir>

  then copy `voting_wasm.js`, `voting_wasm.d.ts`, `voting_wasm_bg.wasm`,
  `voting_wasm_bg.wasm.d.ts`, `wait_async_worker.js`. The rayon snippet is
  unchanged (`wasm-bindgen-rayon-38edf6e439f6d70d`) and kept as is.

- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, wasm-opt (binaryen) 130.
- size: post `-Oz` 6,384,377 bytes.
- sha256(voting_wasm_bg.wasm) =
  c80303a3f005e551cfa6fc1348798f6648341135ed934814d6fb7d4b9a36fb05
- sha256(voting_wasm.js) =
  2809ce92892bbd208a96ae3a34c6552d0bea74ae16376d07685047db252e6404
- sha256(wait_async_worker.js) =
  bb9ceb4f6173068738dbb4e12b12eb58a6b26c2757172d892c7126f7b3a5ec22
  (all three reproduced byte for byte from a second build at the rev above).
- shared imported memory: `(memory $mimport$0 25 32768 shared)`.
- tests: `cargo test --release -p zcash_voting -p voting-wasm` 114 passed;
  `local_chain_e2e` against a local svoted v1.6.1-rc.5 (now also reading
  each cast's position from its tx hash) finalized its tally; in node this
  blob rebuilds the 32 shares that chain's helper accepted and builds a
  delegation PCZT past testnet NU7.

### 2026-10-05 - voting-circuits 0.12 / vote-sdk 1.6 (prod zvote-1)

- source repo: zcli, branch `fix/voting-0.12`, rev `fd8d74b` (on master
  `2e2a02a`): crate `crates/voting-wasm`, `--features parallel`.
- why: zvote-1 runs vote-sdk v1.6.1-rc.5 on voting-circuits 0.12.0. The
  previous blob was built on voting-circuits 0.9.0-rc.3: its proofs no longer
  verify (0.10 and 0.12 changed the delegation and vote keys), proposals stop
  at 15 (prod rounds have 37), and it sent `sighash` where the chain now takes
  `tx1_effects`.
- exports: `build_delegation_pczt` (V6/NU6.3 TX1 profile; context carries
  `tx1_effects_hex`), `finalize_delegation` (wire has `tx1_effects`, no
  `sighash`; checks the signature first), `cast_vote_hot_wire` (adds
  `next_delegation_state_json`), new `build_vote_shares_from_recovery`;
  `generate_voting_hotkey`, `pir_fetch_imt_proofs`, `build_vote_commitment_wire`,
  `build_vote_shares_wire`, `selftest_prove_delegation`, `initThreadPool`
  unchanged.
- recipe (from `crates/voting-wasm`; RUSTFLAGS unset so the workspace
  `.cargo/config.toml` shared-memory link args apply):

      RUSTUP_TOOLCHAIN=nightly cargo build -p voting-wasm \
        --target wasm32-unknown-unknown --release --features parallel \
        -Zbuild-std=panic_abort,std
      wasm-bindgen ../../target/wasm32-unknown-unknown/release/voting_wasm.wasm \
        --out-dir pkg --target web
      wasm-opt -Oz --enable-threads --enable-bulk-memory --enable-simd \
        --enable-mutable-globals --enable-nontrapping-float-to-int \
        pkg/voting_wasm_bg.wasm -o pkg/voting_wasm_bg.wasm

  then copy `voting_wasm.js`, `voting_wasm.d.ts`, `voting_wasm_bg.wasm`,
  `voting_wasm_bg.wasm.d.ts`. The rayon snippet hash is unchanged
  (`wasm-bindgen-rayon-38edf6e439f6d70d`), so the patched `workerHelpers.js`
  (`wbgRayonBase` -> `voting_wasm.js`) was kept as is.

- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, wasm-opt (binaryen) 130
  (`/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130`).
- size: pre `wasm-opt` 11,514,649 bytes; post `-Oz` 6,435,786 bytes (the
  previous blob was 9,914,592 bytes and not `-Oz`'d).
- sha256(voting_wasm_bg.wasm) =
  d3d98cd11ae5b6ba09960a8dcd808906c399f5e643c575cc9b08f23898438a84
- sha256(voting_wasm.js) =
  831f819ce4b328f72c1715cdd467c6c1989b67eeb0bbf763305aa73806a0323f
  (both reproduced from a second build at the rev above).
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 25 32768 shared)`.
- tests: `cargo test -p zcash_voting --release --lib` 111 passed (includes the
  chain's own TX1 fixture and PCZT sighash == TX1 digest); the ignored
  `voting-wasm` `local_chain_e2e` ran these bindings against a local svoted
  v1.6.1-rc.5 (37 proposals, votes on 37 and 17, tally finalized).

## 2026-10-07 rebuild (2) - the deposit's expiry follows the branch, or the move

- source repo: zcli, branch `fix/deposit-expiry-follows-node`, rev `cbd2d7d`
  (zcli PR #29, one commit on master `0886e6d`, the rev of the blob it
  replaces). NOT a master build: rebuild from master once #29 merges and
  replace this entry.
- `build_unsigned_transparent_transaction` takes an optional trailing
  `expiry_delta`: omitted is the branch default (target + 40, or + 120 on
  NU7, as the move gets), given is validated by `resolve_pczt_expiry_height`.
  The result JSON gains `expiry_height`. Previously the deposit always got
  - 40.
- `.d.ts` diff against the previous blob: that one signature (one optional
  arg) and its doc; nothing removed. The glue differs only in that function.
- `cargo test -p zafu-wasm --lib --tests --release` at `cbd2d7d`: 162 passed
  (160 + 2 new in `tests/transparent_op_return.rs`).
- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, binaryen 130; recipe above.
- rayon snippet hash unchanged (`wasm-bindgen-rayon-38edf6e439f6d70d`), the
  patched `workerHelpers.js` kept in both trees.
- size: pre `wasm-opt` 28,653,828 bytes (post-bindgen); post `-Oz`
  13,370,295 bytes (+295).
- sha256(parallel zafu_wasm_bg.wasm) =
  ad3f125937c33ad59bc6232abcee8251fe91b8053c25f59bf678b1a1f7b00be0
- sha256(zafu_wasm.js) =
  7510cd7af67d88a922cc7b00665d9fed9b7a63fdc588a8f56bbaa6d4156218f6
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 58 32768 shared)` (unchanged).

## 2026-10-07 rebuild - verify_flyclient (single-server chain check)

- source repo: zcli, branch `master`, rev `0886e6d` (merge of zcli PR #28,
  `feat/flyclient-wallet`). Since `8cef107` (the blob it replaces) master
  gained 2365555 (a test only) and PR #28.
- #28: new crate `zync-flyclient`; a compiled mainnet checkpoint (height
  3,508,014) with work and difficulty floors, tip freshness (within 90 min
  behind, 2 h ahead of `now_secs`), anti-rollback (`min_height`) and the
  optional note-tree-root burial. zafu-wasm exports
  `verify_flyclient(resp_proto, now_secs, min_height, mainnet)` returning JSON
  `{tip_height, tip_hash, total_work, orchard_root, ironwood_root,
roots_height}`; testnet is refused (no checkpoint).
- `.d.ts` diff against the previous blob: one export added,
  `verify_flyclient`; nothing removed or changed. `zafu_wasm_bg.wasm.d.ts`
  gains its raw binding only. The glue differs by that function and two
  closure shim indices in comments.
- `cargo test -p zafu-wasm --lib --tests --release` at `0886e6d`: 160 passed,
  12 ignored (lib 98).
- checked in node: the live default-parameter proof from zcash.rotko.net
  (tip 3,509,023, 1.52 MB) verifies in ~90 ms and returns roots at 3,509,022;
  the same proof 91 minutes later is refused as stale.
- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, binaryen 130; recipe above.
- rayon snippet hash unchanged (`wasm-bindgen-rayon-38edf6e439f6d70d`), the
  patched `workerHelpers.js` kept in both trees.
- size: pre `wasm-opt` 28,653,365 bytes (post-bindgen); post `-Oz`
  13,370,000 bytes (+84,677).
- sha256(parallel zafu_wasm_bg.wasm) =
  a56afe17905946cb72aed512a75bb35c90d4ad7b7980f8ccbe5cedc3c3728d80
- sha256(zafu_wasm.js) =
  0ee9eeda569fe32e4c97ec1345ebd59d269a28863f64b100f68a35b214cadf6a
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 58 32768 shared)` (unchanged).

## 2026-10-06 rebuild - ironwood memos, NU7 by node branch, THORChain on NU7

- source repo: zcli, branch `master`, rev `8cef107` (merge of zcli PR #26).
  Since `0347f3f` (the blob it replaces) master gained PR #23, #24, #25
  (zidecar only) and #26.
- #23: `decrypt_transaction_memos` (WalletKeys and WatchOnlyWallet) walks the
  ironwood bundle as well as the orchard one, so V6 outputs and their memos
  are no longer dropped. A memo result's `index` now runs over orchard
  actions, then ironwood actions. zafu matches memos by `cmx`, never by
  `index`, so no caller changes.
- #24: the builders take consensus parameters from `NodeParams`: NU7 counts as
  active at the target height exactly when the node reports the NU7 branch
  (0x77190ad9), on any network; every other report leaves the base table
  alone. Default expiry is target + 120 on NU7 (ZIP 218), + 40 before. The
  blob therefore no longer refuses NU7 on mainnet by itself; zafu's worker
  guard (`apps/extension/src/workers/branch-ids.ts`) is the mainnet NU7 gate.
  `mainnet-consensus-wasm.test.ts` now pins that contract.
- #26: the THORChain t->t deposit builds on the node-reported NU7 branch too.
- `.d.ts` diff against the previous blob: one doc comment
  (`build_ironwood_send_pczt` expiry default); no export added, removed or
  changed. `zafu_wasm_bg.wasm.d.ts` byte-identical; the glue differs only in
  the same doc comment.
- `cargo test -p zafu-wasm --lib --tests --release` at `8cef107`: 157 passed,
  12 ignored (lib 96; `nu7_testnet_v6` 5; `transparent_op_return` 9;
  `note_tree` 9).
- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, binaryen 130; recipe above.
- rayon snippet hash unchanged (`wasm-bindgen-rayon-38edf6e439f6d70d`), the
  patched `workerHelpers.js` kept.
- size: pre `wasm-opt` 28,546,487 bytes (post-bindgen); post `-Oz`
  13,285,323 bytes (+461).
- sha256(parallel zafu_wasm_bg.wasm) =
  6a577386a3019e03436a426feb262a6e2299277ae509182ab8b7c1ec7f522e18
- sha256(zafu_wasm.js) =
  638529847d9915c46014b45f0daa927574e6eb8acede605afc284e28d82379b0
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 58 32768 shared)` (unchanged; `ZAFU_WASM_INITIAL_PAGES`
  59 still covers it).
- reproduced: a second build at `8cef107` with its own target directory gave
  both shas above byte for byte.

## 2026-10-05 rebuild (4) - NoteTree.recover_shard, NoteTree.carry_marks

- source repo: zcli master, merge commit `872094d` (zcli PR #22), built from its
  branch head `0347f3f`. The merge commit's `crates/zcash-wasm`, `Cargo.toml` and
  `Cargo.lock` are byte-identical to `0347f3f` (`git diff 0347f3f 872094d` over those
  paths is empty), so the sha below holds for the merge commit.
- new (public data only, nothing takes a key):
  `NoteTree.recover_shard(index, first_position, blocks, positions)` marks
  lost notes by replaying their own 2^16-leaf shard; the replayed shard
  root must equal the root the tree already holds for that range (a
  subtree root, or the frontier and leaves it hashed), so it can only add
  marks. `NoteTree.carry_marks(old)` keeps an old tree's marks in every
  shard whose root the replacing tree confirms.
- also in the blob, from master since 2e2a02a: the zafu-wasm copies of the
  voting functions follow voting 0.12 (`cast_vote_hot_wire` takes no
  `submit_at`; `build_vote_shares_from_recovery` replaces
  `build_vote_shares_wire`). zafu calls these only through voting-wasm, so
  nothing in the extension changes with them.
- `.d.ts` diff against the previous blob: the two NoteTree methods and the
  voting changes above; nothing else removed.
- `cargo test -p zafu-wasm --release --test note_tree`: 9 passed (new:
  `recover_shard_replays_one_shard_only`, `carry_marks_keeps_confirmed_shards`;
  every path compared with a full replay from the empty tree).
- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, binaryen 130; recipe above.
- rayon snippet hash unchanged (`wasm-bindgen-rayon-38edf6e439f6d70d`), the
  patched `workerHelpers.js` kept.
- size: pre `wasm-opt` 21,461,578 bytes; post `-Oz` 13,284,862 bytes.
- sha256(parallel zafu_wasm_bg.wasm) =
  f21a9e2d305ea49554ba6df1bae9af3a2b1e06c35bf5441d62d4e93224380663
- sha256(zafu_wasm.js) =
  d34a87837f0ff320cfdd1877b7a75ffdf2bf2043fc643daf837611d57a727e5b
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 58 32768 shared)`.
- reproduced: a second build from a clean checkout of `0347f3f` with its
  own target directory gave both shas above byte for byte.

## 2026-10-05 rebuild (3) - Zakura Common 2.0, NU7 testnet; built from zcli master

- source repo: zcli, branch `master`, rev `2e2a02a` (0fa1616 plus the
  ironwood-past-NU7 fix below). From here on the blob
  comes from master again: `feat/ledger-on-thor` (092582f) and
  `feat/wasm-shardtree` (94b33e1) were merged into master (81a30eb), then
  `feat/common-2` (0fa1616). `integ/shardtree-blob` is retired. The
  zafu-wasm sources at 81a30eb are identical to `integ/shardtree-blob`
  293d5e9 (the blob this replaces).
- what changes: Zakura Common 1.0 -> =2.0.0 (the exact pin voting-crypto-deps
  0.2.4 needs; voting-circuits 0.12.2, imt-tree 0.5.4, pir-types 0.6.4,
  zakura-pczt rc4). Common 2.0 knows NU7 (branch 0x77190ad9, V6) but has no
  testnet height, so `crate::consensus::TestNetwork` adds NU7 at 4,465,026;
  every testnet tx builder uses it. Mainnet is unchanged (NU7 unscheduled).
- 2e2a02a: the ironwood gates compared the branch id to NU6.3 exactly, so
  past testnet NU7 every ironwood send, shielding and migration was refused.
  They now check `ironwood_active(branch)` (Orchard protocol revision V3:
  NU6.3 and NU7; unknown ids fail closed), and NU7 maps to `orchard_v3`.
  The worker passes the endpoint's validated branch id instead of a NU6.3
  constant.
- `.d.ts` byte-identical to the previous blob; glue differs only in closure
  shim indices and initial memory (56 -> 58 pages).
- `cargo test -p zafu-wasm --lib --tests --release`: green (lib 91 passed;
  new `nu7_testnet_v6` builds a turnstile migration and an ironwood
  send past testnet NU7, bound to 0x77190ad9; the send fails on 0fa1616 with
  the same error zafu CI hit).
  The ledger `PreNu6_3TestNetwork` fixture now also leaves NU7 off.
- toolchain and recipe as below (nightly, wasm-bindgen 0.2.126, binaryen 130).
- parallel variant only, copied to both `packages/zcash-wasm/` and
  `apps/extension/public/zafu-wasm/`; rayon snippet hash unchanged
  (`wasm-bindgen-rayon-38edf6e439f6d70d`), patched `workerHelpers.js` kept.
- size: post `-Oz` 13,218,997 bytes (was 10,255,183). One halo2 and one rayon
  in the graph; the growth is Common 2.0's halo2_proofs (+1.9 MB pre-opt) and
  the rayon closures it instantiates (+0.8 MB), not a duplicated crate.
- sha256(parallel zafu_wasm_bg.wasm) =
  d7c3bf9115f922911d96b4adf1cd7570e9f8529ed93e9c4f502d3d600ee0cd81
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 58 32768 shared)`.

## 2026-10-05 rebuild (2) - NoteTree.recover, checkpoint_at_or_below

- source repo: zcli, branch `integ/shardtree-blob`, rev `293d5e9` = the blob
  below plus `feat/wasm-shardtree` 94b33e1 cherry-picked (no conflicts).
- new (public data only, nothing takes a key): `NoteTree.recover(frontier_hex,
blocks, positions, height)` (replays from a frontier up to a retained
  checkpoint and inserts witnesses for notes the tree lost; inserts nothing
  unless the replay ends at that checkpoint with its root) and
  `NoteTree.checkpoint_at_or_below(height)`.
- `.d.ts` diff against the previous blob: those two methods; nothing removed.
- `cargo test -p zafu-wasm --release --test note_tree`: 7 passed.
- toolchain and recipe as below (nightly, wasm-bindgen 0.2.126, binaryen 130).
- parallel variant only, copied to both `packages/zcash-wasm/` and
  `apps/extension/public/zafu-wasm/`; rayon snippet hash unchanged
  (`wasm-bindgen-rayon-38edf6e439f6d70d`), patched `workerHelpers.js` kept.
- size: pre `wasm-opt` 22,414,445 bytes; post `-Oz` 10,255,183 bytes.
- sha256(parallel zafu_wasm_bg.wasm) =
  b1ad96f655c44b9e04b6eecb429bcb2f13efceae4760acdcb6ebfc0aff89d6ff
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 56 32768 shared)`.

## 2026-10-05 rebuild - NoteTree (note commitment trees as shards)

- source repo: zcli, branch `integ/shardtree-blob` (from `feat/ledger-on-thor`
  092582f, the rev of the blob it replaces), rev `21c35e5` = the three commits
  of `feat/wasm-shardtree` (11444c4, 9c85bfe, acc993e, on master 2ae5843)
  cherry-picked as 2d535a4, d2f1b3b, 21c35e5. The only conflict was the module list at
  the top of `src/lib.rs` (both kept).
- new (public data only, nothing takes a key): the `NoteTree` class (shardtree
  0.7.1, depth 32, shards of 16): `load_shard`, `load_cap`,
  `load_checkpoints`, `insert_frontier`, `insert_witness`,
  `insert_subtree_roots`, `append_blocks`, `latest_checkpoint`,
  `oldest_checkpoint`, `next_position`, `is_marked`, `root_at`, `witness`,
  `truncate`, `take_changes`.
- `.d.ts` diff against the previous blob: the `NoteTree` class only; nothing
  removed or changed.
- `cargo test -p zafu-wasm --release --test note_tree`: 5 passed (every
  witness compared with a full replay from the empty tree); the full
  `--lib --tests --release` suite is green on `feat/wasm-shardtree`.
- toolchain: nightly `rustc 1.95.0-nightly`, wasm-bindgen CLI 0.2.126,
  wasm-opt (binaryen) version 130
  (`/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130`); recipe as in
  the parallel section above.
- parallel variant only, copied to both `packages/zcash-wasm/` and
  `apps/extension/public/zafu-wasm/` (glue, `.d.ts`, `_bg.wasm`,
  `_bg.wasm.d.ts`). The rayon snippet hash is unchanged
  (`wasm-bindgen-rayon-38edf6e439f6d70d`), so the patched `workerHelpers.js`
  (`wbgRayonBase` defined and used) was kept as is.
- size: pre `wasm-opt` 22,407,705 bytes; post `-Oz` 10,250,206 bytes.
- sha256(parallel zafu_wasm_bg.wasm) =
  40228df4b4c6320f59f78dddd7f17a0872487cf4dcf6d183f8cedecda2235740
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 56 32768 shared)`.

## 2026-10-02 rebuild (2) - Ledger Zcash app protocol on top of the OP_RETURN blob

- source repo: zcli, branch `feat/ledger-on-thor` (from `feat/thor-op-return`
  8923975, the rev of the blob it replaces), rev `092582f`. The three Ledger
  commits of `feat/ledger-zcash-app` (eaf40a1, b370415, eaa9360, on master
  e212d03) cherry-picked as 3279742, a74328c, 3da7444; the only conflict was
  the module list at the top of `src/lib.rs` (both sides kept). 092582f
  passes the new explicit expiry delta in the ledger stamping test and makes
  the `only_worker_side_exports_take_wallet_secrets` guard walk `src/ledger/`
  (it read `src/` flat and stopped on the new directory; no ledger export
  takes a phrase, seed or private key).
- new (public data only, nothing takes a key): `ledger_ufvk_plan`,
  `ledger_ufvk_remaining_bytes`, `ledger_parse_ufvk`, `ledger_validate_pczt`,
  `ledger_pczt_signing_plan`, `ledger_finalize_pczt_signing`,
  `ledger_stamp_derivations` (ported from vizor-wallet, Apache-2.0, see
  crates/zcash-wasm/LICENSE-APACHE-vizor); and a trailing optional
  `ovk_from_ufvk` on `build_unsigned_shielding_transaction_ironwood` (the
  Ledger app refuses a shielding output it cannot decrypt).
- `.d.ts` diff against the previous blob: the seven `ledger_*` exports and
  the one trailing optional argument; nothing removed or changed. Every
  export of feat/seed-sign-in-worker (`SpendKeys`) and feat/thor-op-return
  (`plan_transparent_transaction`, `build_unsigned_transparent_transaction`)
  is present.
- `cargo test -p zafu-wasm --lib --tests --release`: all green (lib 90
  passed, 51 of them `ledger::`; `hot_sign_split` 7 passed). Ignored as
  before: the Speculos round trip (`ledger::speculos_tests`, needs
  SPECULOS_URL) and the regtest suites.
- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, wasm-opt (binaryen) version 130
  (`/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130`); recipe as in
  the parallel section above.
- parallel variant only, copied to both `packages/zcash-wasm/` and
  `apps/extension/public/zafu-wasm/` (glue, `.d.ts`, `_bg.wasm`,
  `_bg.wasm.d.ts`). The rayon snippet hash is unchanged
  (`wasm-bindgen-rayon-38edf6e439f6d70d`), so the patched `workerHelpers.js`
  (`wbgRayonBase` defined and used) was kept as is.
- size: pre `wasm-opt` 22,159,484 bytes; post `-Oz` 10,078,678 bytes.
- sha256(parallel zafu_wasm_bg.wasm) =
  be68b5d235cf9b410dc5101eeb846b0374418e73bd56ff7983901cea71446ed8
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 55 32768 shared)`.

## 2026-10-02 rebuild - unsigned t->t with an OP_RETURN (THORChain deposits)

- source repo: zcli, branch `feat/thor-op-return` (from
  `feat/seed-sign-in-worker` f94dd39, the rev of the blob it replaces), rev
  `8923975`. One change: `src/transparent_send.rs`.
- new (public data only, nothing takes a key):
  `plan_transparent_transaction(utxos_json, amount, null_data_hex)` ->
  `{inputs, total_in, fee, change, short}`, and
  `build_unsigned_transparent_transaction(utxos_json, pubkey_hex, recipient,
amount, target_height, expected_branch_id, mainnet, null_data_hex)` -> the
  plan plus `{sighashes, unsigned_tx_hex}` (a V5 PCZT, outputs [recipient,
  OP_RETURN, change to the same address], ZIP-317 fee). Signed in the worker
  with the existing `SpendKeys.sign_shielding` (doc widened, API unchanged).
- `.d.ts` diff against the previous blob: the two exports above and the
  `sign_shielding` doc comment; nothing removed or changed.
- `cargo test -p zafu-wasm --lib --tests --release`: all green, including the
  new `tests/transparent_op_return.rs`; the ignored
  `tests/regtest_transparent_op_return.rs` mined the deposit on zebrad 6.2.3
  regtest (NU6.3 from block 1) as a V5 tx at exactly the ZIP-317 fee.
- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, wasm-opt (binaryen) version 130
  (`/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130`); recipe as in
  the parallel section above.
- parallel variant only, copied to both `packages/zcash-wasm/` and
  `apps/extension/public/zafu-wasm/` (glue, `.d.ts`, `_bg.wasm`,
  `_bg.wasm.d.ts`). The rayon snippet hash is unchanged
  (`wasm-bindgen-rayon-38edf6e439f6d70d`), so the patched `workerHelpers.js`
  (`wbgRayonBase` defined and used) was kept as is.
- size: pre `wasm-opt` 22,008,563 bytes; post `-Oz` 9,955,743 bytes.
- sha256(parallel zafu_wasm_bg.wasm) =
  4ed7ef7a18819a610ad51eb4b953ea2369c38d1feabba301e94bc56e7c9fdfce
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 55 32768 shared)`.

## 2026-10-01 rebuild (2) - hot sends signed in the worker, proven seed-free

- source repo: zcli, branch `feat/seed-sign-in-worker` (from
  `integ/zafu-wasm-2026-10` f9eb264), rev `f94dd39`. SpendKeys derives at
  coin type 133 on every network, like the scanner (`WalletKeys`).
- new: the `SpendKeys` class (`new SpendKeys(phrase, account, mainnet)`,
  `ufvk()`, `receiving_address()`, `sign_pczt(pczt_hex)`,
  `transparent_pubkey(index)`, `sign_shielding(index, unsigned_tx_hex,
sighashes_json)`, `free()`). The zcash worker builds it from the vault it
  unsealed; the offscreen prover only ever gets the UFVK.
- removed (they took the phrase or a transparent private key, and rode the
  prover relay): `build_signed_spend_transaction`, `build_signed_ironwood_send`,
  `build_signed_turnstile_migration`, `build_shielding_transaction`,
  `build_shielding_transaction_ironwood`, `build_shielding_transaction_auto`,
  `derive_transparent_privkey`. Hot sends now use the cold builders
  (`build_ironwood_send_pczt`, `build_turnstile_migration_pczt`,
  `build_unsigned_pczt`, `build_unsigned_shielding(_ironwood)`) and sign in
  the worker.
- `cargo test -p zafu-wasm --lib --tests --release`: all green, including the
  new `tests/hot_sign_split.rs`.
- toolchain: nightly `rustc 1.95.0-nightly (6a979b3e3 2026-02-26)`,
  wasm-bindgen CLI 0.2.126, wasm-opt (binaryen) version 130; recipe as in the
  parallel section above (`cargo wasm-parallel`, `wasm-bindgen --target web`,
  `wasm-opt -Oz --enable-threads --enable-bulk-memory --enable-simd
--enable-mutable-globals --enable-nontrapping-float-to-int`).
- parallel variant only, copied to both `packages/zcash-wasm/` and
  `apps/extension/public/zafu-wasm/` (glue, `.d.ts`, `_bg.wasm`,
  `_bg.wasm.d.ts`). The rayon snippet hash is unchanged
  (`wasm-bindgen-rayon-38edf6e439f6d70d`), so the patched `workerHelpers.js`
  (`wbgRayonBase` defined and used) was kept as is.
- size: pre `wasm-opt` 21,910,928 bytes; post `-Oz` 9,872,355 bytes.
- sha256(parallel zafu_wasm_bg.wasm) =
  d8ae22c4fc23f0c401b650cd7cfffa56df82498202a7cef8465b7bea18117dff
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 55 32768 shared)`.

## 2026-10-01 rebuild - explicit PCZT expiry + inspection fields + per-account WalletKeys

- source repo: zcli, integration branch `integ/zafu-wasm-2026-10`, rev
  `f9eb264` (merge into `origin/master` f597bb0; message amended after the
  merge to add commit detail and attribution, tree unchanged - `git diff
--stat` between the original merge sha and `f9eb264` is empty). Built from
  TWO feature
  branches merged for this rebuild, both clean fast-forward/auto-merges with
  no conflicts:
  - `feat/pczt-explicit-expiry` (594fc82, on top of 23f2c60): explicit PCZT
    expiry on `build_unsigned_pczt` / `build_ironwood_send_pczt` (new trailing
    optional `expiry_delta?: number | null` argument, after `memo_hex`), plus
    new `frost_inspect_pczt_outputs` fields: `fee_zat`, `expiry_height`,
    `tx_version`, `consensus_branch_id`, `value_balance_zat` (`{orchard,
ironwood, sapling}`), `sapling_present`, `transparent_input_count`,
    `transparent_input_total_zat`, `transparent_outputs` (`[{value_zat,
script_pubkey_hex, address}]`), `committed_outputs_error`, and per-action
    `committed_value_zat`, `committed_recipient_raw_hex`, `cmx_verified`,
    `recipient_scope`. These are exactly the fields
    `apps/extension/src/routes/popup/send/frost-multisig/multisig-verifier.ts`
    `verifySealedIntent` was already coded against (fail-closed on
    `committed_outputs_error` missing) - names matched byte for byte, no TS
    changes needed.
  - `feat/wallet-keys-account` (154bfde): `WalletKeys.from_seed_phrase_account
(seed, account)`, a new static method; the existing bare
    `WalletKeys(seed_phrase)` constructor now delegates to it with account 0,
    byte for byte unchanged. This is the export
    `apps/extension/src/workers/pocket-keys.ts` `pocketWalletKeys()` guards
    on before allowing pocket N>0 - previously absent from the shipped blob,
    so every pocket > 0 threw "needs a newer zafu-wasm".
- `cargo test -p zafu-wasm --lib --tests --release` on the merged tree: all
  green (18 `test result: ok` blocks, 0 failed; 1 pre-existing ignored test
  awaiting an external zashi/keystone fixture, unrelated). The crate's
  `benches` target does not compile on master and was skipped, as expected.
- toolchain: wasm-bindgen CLI 0.2.126, wasm-opt (binaryen) version 130.
  The task asked for wasm-bindgen 0.2.114 pinned + verified; installed it
  (`cargo install wasm-bindgen-cli --version 0.2.114 --locked`) and tried it
  first, but it refused with a schema mismatch:
  ```
  rust Wasm file schema version: 0.2.126
     this binary schema version: 0.2.114
  ```
  `Cargo.lock` pins `wasm-bindgen 0.2.126` (unchanged from every rebuild
  since 2026-08-06, see that entry: js-sys forces it). Reverting the crate's
  wasm-bindgen dependency to 0.2.114 is a dependency-graph decision out of
  scope for this rebuild, so the CLI already on the machine (0.2.126) was
  used instead, consistent with every entry below since 2026-08-06.
  binaryen: downloaded the official
  `binaryen-version_130-x86_64-linux.tar.gz` release tarball and verified its
  sha256 against the value published on the GitHub release page
  (`0a18362361ad05465118cd8eeb72edaeec89de6894bc283576ef4e07aa3babcc`) before
  extracting - matched.
- built (UTC): 2026-09-30 ~22:41 (05:41 +0700) (nightly toolchain `rustc
1.95.0-nightly (6a979b3e3 2026-02-26)`, commit
  `6a979b3e32522049d0acb4a47f7ae44b7c8abfd5`).
- only the PARALLEL variant was built and shipped, matching the 2026-08-05
  correction below: `packages/zcash-wasm/` and
  `apps/extension/public/zafu-wasm/` are BOTH the parallel/rayon build; there
  is no single-thread consumer left to refresh.
- size: pre `wasm-opt` 22,011,140 bytes; post `-Oz` 9,952,339 bytes (previous
  shipped blob was 8,765,230 bytes - the growth is the Zakura Common 1.0
  proving stack + new inspection/expiry code compiled in from master, not a
  build regression).
- sha256(parallel zafu_wasm_bg.wasm) =
  0c8719cc5094821fb1f9bf93226fddbcf9e2bc66af603648152d2191b4209249
- shared imported memory confirmed post-bindgen:
  `(memory $mimport$0 56 32768 shared)`. Full rayon export set present
  (`initThreadPool`, `wbg_rayon_start_worker`, `__wbindgen_thread_destroy`
  in the `.d.ts`).
- `.d.ts` diff against the previous shipped blob: no new top-level
  `export function`/`export class` names (the new surface is the
  `expiry_delta` param and the `WalletKeys.from_seed_phrase_account` static
  method, both additive inside existing declarations).
- snippets: same `wasm-bindgen-rayon-38edf6e439f6d70d` hash as before (dep
  unchanged); re-applied the Chrome worker patch
  (`wbgRayonBase` defined and used, zero live `import('../../..')`) to the
  freshly generated `workerHelpers.js` before copying, in both trees.
- this is the first shipped blob built off zcli `master` proper (not a
  narrower feature branch) since the 2026-09-27 rebuild deliberately avoided
  it because master carries the unverified Zakura Common 1.0 proving swap +
  `getrandom_backend="wasm_js"` cfg (see that entry). That swap is therefore
  now live in the shipped extension for the first time via this rebuild.
- reproducibility check: rebuilt the 2026-09-27 rev (`feat/random-diversifier-zafu`
  c238955, recorded hash `11413627f69a...`) from scratch with the identical
  recipe (bindgen 0.2.126, `wasm-opt -Oz` with the same flag set, the same
  GitHub-release binaryen 130 binary) in its existing worktree. Result:
  `sha256(zafu_wasm_bg.wasm) = 11413627f69a1fbab16aab0a8c8c43ef1ff1719537dc07e3c10e2040d5843a29`
  - an exact match to the recorded value. The toolchain reproduces an
    unchanged input byte for byte; no `zcash_*` duplicate exists in
    `packages/zcash-wasm/` to keep in sync (package `main`/`exports` already
    resolve `zafu_wasm.js` directly, per the 2026-08-07 fix above).

Verified after copying (both `packages/zcash-wasm/` and
`apps/extension/public/zafu-wasm/`, confirmed byte-identical):

- `pnpm -w exec tsc --noEmit -p apps/extension`: clean, exit 0.
- `pnpm vitest run` in `apps/extension`: 1009 passed, 10 skipped, 0 failed
  (matches the pre-rebuild baseline of 1009 exactly). A transient single
  failure in `src/clients.worker-env.test.ts` (5s timeout) on one run was
  CPU-contention from a concurrent cargo build, not a regression - it passes
  alone in 123ms and passed in the clean full rerun.
- `src/workers/pocket-keys.test.ts`, `pocket-isolation.test.ts`,
  `src/state/pockets.test.ts`,
  `src/routes/popup/send/frost-multisig/multisig-verifier.test.ts`,
  `sealed-intent.test.ts`: all green (83 tests). `pocket-keys.test.ts`
  exercises the real wasm `from_seed_phrase_account` export end to end
  (pocket 0 matches the legacy constructor byte for byte; pocket 1 derives a
  different ZIP 32 account-1 key).
- `pnpm lint`: pre-existing prettier drift in 14 unrelated files (none of
  them touched by this rebuild - no `.tsx`/`.ts` source file was edited,
  only the vendored wasm blobs, glue and this provenance doc) already fails
  on `rework/base` before this change; not introduced here.
- prod (`webpack.prod-config.ts`) and beta (`webpack.beta-config.ts`) both
  compile clean, one expected warning each (the local worker-patch
  `wbgRayonBase` dynamic import is flagged by webpack as a "critical
  dependency: the request of a dependency is an expression" - this is the
  same LOCAL PATCH warning documented in the 2026-08-05 entry, not new).
  `dist/zafu-wasm/` and `beta-dist/zafu-wasm/` both carry
  `zafu_wasm_bg.wasm` sha256 `0c8719cc...` (matches the built blob exactly;
  no stale `11413627...` blob survives in either output tree), and both
  `zafu_wasm.js` glues contain `from_seed_phrase_account`.
- headless render (`shoot.cjs`, real playwright+chromium, imports the
  `abandon...art` test wallet): both `dist/` and `beta-dist/` render `/`
  and `/settings` in both themes with zero page errors; `/` shows the
  wallet home mid-sync ("syncing 0%").

## 2026-09-27 rebuild - full 88-bit diversifier index (random receive addresses)

- source repo: zcli, branch `feat/random-diversifier-zafu`, rev `c238955`
  = `c111a06` (the rev of the blob it replaces, d6244ea9) + one commit adding
  `get_address_at_index`, `get_receiving_address_at_index` and
  `address_from_ufvk_at_index`. Deliberately NOT built from zcli master: master
  is 48 commits ahead and carries the Zakura Common 1.0 proving swap, which has
  not been verified in zafu. The same commit is on `feat/random-diversifier`
  (off master) for when that lands.
- toolchain: wasm-bindgen 0.2.126, wasm-opt (binaryen) 130
  (/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130).
- parallel build: `env -u RUSTFLAGS RUSTUP_TOOLCHAIN=nightly cargo wasm-parallel`,
  `wasm-bindgen --out-dir pkg-parallel --target web`, `wasm-opt -Oz` with the
  standard flag set. Shared imported memory `(memory 50 32768 shared)` verified.
- sha256(parallel zafu_wasm_bg.wasm) =
  11413627f69a1fbab16aab0a8c8c43ef1ff1719537dc07e3c10e2040d5843a29
- `.d.ts` diff against the previous blob: exactly the three new exports, nothing
  removed or changed. Both trees updated byte-identical (wasm + glue + d.ts);
  `snippets/` untouched, so the worker rayon patch (`wbgRayonBase` defined and
  used) is preserved.
- KNOWN, pre-existing: 21c7b17d (2026-08-29) shipped blob 980a08f0 built from
  zcli 5650976 (frostd challenge signed over raw uuid bytes); merge 7a7c6f15
  then restored this older c111a06 blob, so the frostd raw-uuid wasm fix is not
  in the shipped wasm. This rebuild keeps that state; restoring it means
  building from 5650976, which also brings the dc8b752 proving-fork bump.

## 2026-08-19 rebuild (2) - retain UNREDACTED ironwood pczt (compact-sign FVK fix)

- source repo: zcli, branch `master`, rev `c111a06`
  (fix(ironwood): retain the UNREDACTED pczt so compact-sign merge keeps the fvk).
- toolchain: wasm-bindgen 0.2.126, wasm-opt (binaryen) **130**
  (/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130).
- parallel build: `env -u RUSTFLAGS RUSTUP_TOOLCHAIN=nightly cargo wasm-parallel`;
  `wasm-bindgen --out-dir pkg-parallel --target web`; `wasm-opt -Oz` with the
  standard flag set. Shared imported memory `(memory 50 32768 shared)` verified
  post-bindgen.
- sha256(parallel zafu_wasm_bg.wasm) =
  d6244ea92d2e59360d24ea3adb8fa761b5cf6e0b6628031989bf884b9d45f075
- Fixes the compact (0x05 -> 0x07 signatures-only) ironwood cold send, which
  died at merge time with `IronwoodVerify(MissingFullViewingKey)` (surfaced in
  the extension as a bare "failed to build transaction"). `build_ironwood_send_pczt`
  returned only the `redact_pczt_for_signer` copy (fvk/witness/note-plaintext
  stripped); the wallet retained THAT and re-applied the device's signatures into
  it, but pczt's `apply_ironwood_signature` runs `verify_nullifier`, which needs
  the fvk. Now `build_ironwood_send_pczt` ALSO returns `retained_pczt_hex` (the
  UNREDACTED base, WITH the fvk) for the wallet to keep + merge into; `pczt_hex`
  stays the redacted device copy. The fvk NEVER leaves the wallet (the request is
  still built from `pczt_hex`). Full 0x03 sends were unaffected (they extract the
  device's signed pczt, no merge). Mirrors vizor keeping the unredacted base.
- Reproduced + guarded natively: zcli `crates/zcash-wasm/tests/fvk_repro.rs`
  drives the real `apply_signature_contributions` merge - redacted retained ->
  `MissingFullViewingKey`; unredacted -> passes `verify_nullifier`. The
  zigner-side `ironwood_send_fixture` harness could not catch it: it merges via
  zigner's `pczt_signing`, not this zcli export.
- Internals-only: `zafu_wasm.js` / `.d.ts` BYTE-IDENTICAL to the previous blob
  (`retained_pczt_hex` is an added field on an already-`JsValue` return;
  `apply_signature_contributions_inner` is a plain fn, not a `#[wasm_bindgen]`
  export). Only `zafu_wasm_bg.wasm` changed. Both trees (`packages/zcash-wasm/`,
  `apps/extension/public/zafu-wasm/`) updated byte-identical; worker rayon patch
  (`wbgRayonBase`) preserved (only bg.wasm swapped, snippets untouched).

## 2026-08-19 rebuild - single-part UR decode (compact sign response)

- source repo: zcli, branch `master`, rev `50f7a6c` (fix(ur): decode single-part
  UR frames).
- toolchain: wasm-bindgen 0.2.126, wasm-opt (binaryen) **130**
  (/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130).
- parallel size after -Oz: 8762095 bytes; shared imported memory
  `(memory 50 32768 shared)` confirmed.
- sha256(parallel zafu_wasm_bg.wasm) =
  6b0812136cb81147699489f2d5d7cf56e515c880b5998ab6a7d3f1ac3a245856
- Fixes `ur_decode_frames`: a payload that fits one QR fragment is emitted as a
  bare single-part UR `ur:<type>/<bytewords>` (via `ur::ur::encode`, no
  `<seq>-<len>/` header) - e.g. the compact signatures-only sign response, one
  static frame. The fountain `Decoder` only ever finalizes _sequenced_
  multi-part frames, so a lone single-part frame looped forever as "need more
  frames" (zafu scanner stuck at "1 part received / 10%"). Now a single
  non-sequenced frame is decoded directly via `ur::ur::decode`; multi-part
  streams still take the fountain path. Unit-tested natively (single_part_ur
  decodes in one frame; multipart detection). This is the wallet-side half of
  compact signing - `COMPACT_SIGN_REQUEST` sends a compact request and the
  device replies with a 1-frame signatures-only response that zafu can now scan.
- Internals-only: `zafu_wasm.js` / `.d.ts` byte-identical to the previous blob
  (no export added - `ur_decode_frames` already existed); only
  `zafu_wasm_bg.wasm` changed. Both trees (`packages/zcash-wasm/`,
  `apps/extension/public/zafu-wasm/`) updated byte-identical; worker patch intact
  (`wbgRayonBase` defined+used, zero `import('../../..')`). No `zcash_*`
  duplicate (package resolves `zafu_wasm.js`).

## 2026-08-18 rebuild - compact redaction losslessness (compact_resolvable_fields)

- source repo: zcli, branch `master`, rev `9386a35` + UNCOMMITTED working-tree
  change to `redact_pczt_compact` (commit lib.rs before treating this as
  reproducible).
- toolchain: wasm-bindgen 0.2.126, wasm-opt (binaryen) **130**
  (/nix/store/azhmf1il8da9pps80bk2f4l6ql6bgfg7-binaryen-130).
- parallel size after -Oz: 8760020 bytes; shared imported memory
  `(memory 50 32768 shared)` confirmed.
- sha256(parallel zafu_wasm_bg.wasm) =
  88c5cb08753aa9995563f0f17c7c4ada39816ce39821dd53d5e201db2de9f372
- Fixes `redact_pczt_compact`: replaced the hand-rolled per-action `clear_cmx()`
  - `replace_enc_ciphertext_with_memo_plaintext([0u8;512])` with the canonical
    `redactor.compact_resolvable_fields()` primitive (pczt 0.9.3), which clears
    cmx/cv_net/enc_ciphertext ONLY when the device's `resolve_fields()` reproduces
    them byte-for-byte and restores the original otherwise. The old version signed
    a different sighash than the retained tx (empty-memo hardcode destroyed real
    memos AND corrupted randomized padding-dummy ciphertext), so compact
    signatures failed to merge with `IronwoodSign(InvalidExternalSignature)` on
    EVERY ironwood-send shape. Matches upstream
    `zcash_client_backend::redact_pczt_for_batch_signer` MINUS the bsk/zkproof
    clears (deliberately retained so the zigner's on-device fee-vs-bsk check still
    runs). Verified natively (no browser): zigner
    `pczt_signing/tests/ironwood_send_fixture.rs` drives the real module0.wasm -
    compact sigs merge clean on single / memo / z->t / multi-note.
- Internals-only: `zafu_wasm.js` / `.d.ts` byte-identical to the previous blob;
  only `zafu_wasm_bg.wasm` changed. Both trees (`packages/zcash-wasm/`,
  `apps/extension/public/zafu-wasm/`) updated byte-identical; worker patch intact
  (`wbgRayonBase` defined+used, zero `import('../../..')`).
- COMPACT_SIGN_REQUEST stays OFF by design (single send compacts only ~1.15x);
  the fix makes compact CORRECT for the batch migration/voting flows that use it.

## 2026-08-17 rebuild (2) - fix compact redaction cv_net (ironwood cold-sign)

- source repo: zcli, branch `master`, rev `9386a35`
- toolchain: wasm-bindgen 0.2.126, wasm-opt (binaryen) **130** (canonical; last
  rebuild used the local 117 - byte outputs differ by binaryen version)
- parallel size after -Oz: 8755225 bytes; parallel blob carries shared imported
  memory `(memory 50 32768 shared)`.
- Fixes `redact_pczt_compact`: it cleared `cv_net` on a PCZT whose `spend.value`
  was already stripped by `redact_pczt_for_signer`, so the device's
  `resolve_cv_net` could not rebuild it and rejected an ironwood compact sign
  with `orchard::pczt::ParseError::InvalidValueCommitment`. Now retains `cv_net`
  (32 public bytes/action; the large cmx + enc_ciphertext savings are kept).
  This re-enables `COMPACT_SIGN_REQUEST = true` for ironwood (small QR).
- Only `zafu_wasm_bg.wasm` + the worker-patched `snippets/` changed; the
  bindgen glue (`zafu_wasm.js` / `.d.ts`) is byte-identical (internals-only fix).
- Verified: both copies (`public/zafu-wasm/`, `packages/zcash-wasm/`) updated;
  worker patch re-applied (`wbgRayonBase` defined+used, zero `import('../../..')`);
  beta bundle green, new blob present in `beta-dist/zafu-wasm/`.

## 2026-08-17 rebuild - cold/watch-only ironwood shielding

- source repo: zcli, branch `master`, rev `01d9715`
- toolchain: wasm-bindgen 0.2.126, wasm-opt (binaryen) **117** (NOT 130 - the
  local binaryen at hand; -Oz byte-output differs by binaryen version, so these
  blobs will not sha-reproduce under 130. Functionally correct: parallel blob
  verified to carry shared imported memory `(memory 50 32768 shared)`.)
- parallel size after -Oz: 8775443 bytes
- Adds the NU6.3 cold/watch-only/zigner unsigned shielding surface the wallet
  needs: `build_unsigned_shielding_transaction_ironwood` +
  `complete_shielding_pczt` (the latter also reached via the PCZT-magic sniff in
  `complete_shielding_transaction`). Finishes the migration the hot shielding
  path already had; the orchard unsigned builder stays fail-closed post-NU6.3.
- Verified: both copies (`public/zafu-wasm/`, `packages/zcash-wasm/`) carry the
  new export; the Chrome worker patch (`wbgRayonBase`) was re-applied to
  `snippets/*/src/workerHelpers.js` in both (zero stray `import('../../..')`);
  no `zcash_*` duplicates in this tree (package resolves `zafu_wasm.js`).

## 2026-08-16 rebuild - Noise_K DKG sealing + frostd relay cipher

- source repo: zcli, branch `master`, rev `bd9c63e`
- toolchain: wasm-bindgen 0.2.126, binaryen 130
- sha256(single-thread zafu_wasm_bg.wasm) = 7fb97583fc7e680cce0e8c75eadd994d4503beb3249d69d51154b8aabf197824
- sha256(parallel zafu_wasm_bg.wasm) = e00e659b4ebc979ca9eb10921eaa8c2b58f34fd1e7c96322267277356fe1bf05
- Adds FrostRelayCipher + frost_relay_generate_keypair: Noise_K end-to-end
  encryption for relay traffic, byte-compatible with ZF's frost-client (the
  interop is asserted in Rust, in zcli's frostd_transport tests).
- Carries the DKG round-2 sealing. Before this blob, round-2 packages were
  signed but sent in the clear, and for any n > t an observer of the traffic
  could interpolate the dealers' polynomials and recover the group key.
- WIRE BREAK: DKG is now wire version 2 and refuses a v1 peer. Every
  participant must be on this blob or newer; a half-sealed ceremony leaks
  exactly as much as an unsealed one, so the mismatch fails loudly.
- Verified: parallel blob has shared imported memory (50 32768 shared);
  worker patch re-applied; 475 extension tests pass.

## 2026-08-11 rebuild - voting stack + ironwood completion + FROST send builder

- source repo: zcli, branch `master`, rev `6df7849`
- toolchain: wasm-bindgen 0.2.126, binaryen 130 (the older doc says 0.2.114 -
  that is STALE; the crate now depends on 0.2.126, so the CLI must match it).
- sha256(single-thread zafu_wasm_bg.wasm) = 7adb070bbbca20121cad0a82f3d3127a0ff02da58a27b43409bbec1cfa4ac839
- sha256(parallel zafu_wasm_bg.wasm) = 968360fa1587811022603ff01cf6cbdbe8c5e71152ed900a3f0e9c84ffed45ef
- Brings the entire voting stack to the shipped blob (was missing, so voting
  was dead in the extension): build_delegation_pczt, finalize_delegation,
  build_vote_commitment_wire, cast_vote_hot_wire, build_vote_shares_wire,
  generate_voting_hotkey; plus complete_ironwood_pczt, pczt_has_ironwood_actions,
  and the build_unsigned_pczt NU6.3 fail-close.
- Verified: zcash*\* == zafu*\* byte-identical in packages/; parallel blob has
  shared imported memory (0x03, max 32768); worker patch re-applied
  (wbgRayonBase defined+used, zero live `import('../../..')`); pnpm build green.

## 2026-08-06 rebuild — ironwood witness + scan speedup + Pool type

- source repo: zcli, branch `master`, rev `cc7f9d5`
- sha256(zafu_wasm_bg.wasm) = 1377d1e32cb7d24df0cca7b5102bb0f8c8592140e8d7bd6948222f08c132e9e5
- toolchain: wasm-bindgen 0.2.126, binaryen 123

Carries three zcli changes that had not reached the extension:

- **witness building is per pool** (`0758c75`). It was orchard-only: seeded
  from `get_tree_state`, replayed `block.actions`, returned one anchor.
  Ironwood commitments live in a separate tree, so an ironwood note got a
  merkle path against the wrong tree — a wrong anchor and a rejected spend.
  `pool: Pool` replaced the unused `_mainnet: bool` in the same argument slot,
  so every call site failed to compile rather than silently defaulting. The
  cached frontier is now per pool: the two frontiers are byte-compatible, so a
  cross-pool cache would have been undetectable inside the builder.
- **scan decrypts against one domain** when the pool is known (`71e0812`).
  The scan entry points are per-pool and were using that only as an output
  label while still trying both note-version domains — double work on every
  action of a half-million-block sync.
- **one `Pool` type** (`cc7f9d5`), moved into zafu-wasm so the scanner can see
  it. It previously lived in zecli, which depends on this crate, so the
  scanner dispatched on a `&str` with a silent `_ => try both` fallback.

Glue note: `zafu_wasm.js` gained 8 lines (`Object.entries`, array index
intrinsics) because `FoundNote.pool` is now a serde enum rather than a
`String`. Export surface is unchanged at 69 functions; the serde
representation is deliberately identical (`"orchard"` / `"ironwood"`), so
persisted notes and JS-facing scan results keep the same shape.

Verified: three blobs byte-identical, shared imported memory (flags 0x03,
max 32768 pages), full rayon export set, snippets patched in BOTH trees with
zero live `import('../../..')`, tsc clean, 40 files / 373 tests, build green,
blob present 4x across dist/ and beta-dist/ with no stale blob surviving.
Both real-validator gates re-run against zcli master: ironwood (now spending
a note from a 4-leaf-deep tree via the replayed witness) and turnstile.

## 2026-08-06 rebuild — reconciled migration, merged to zcli master

Supersedes the two entries below. Those blobs were built from
`feat/upstream-crates`, a branch that has since been reconciled with a
SECOND, independent migration (`fix/drop-orchard-forks`) done in parallel.
Neither branch was a superset of the other:

- the other branch was BROADER — it also dropped the `conradoplg/orchard`
  fork from `frost-spend` and `zync-core`, and avoided `halo2_gadgets`
  0.3.1 (GHSA soundness advisory) by dropping `default-features` on
  zync-core's orchard dep. `Cargo.lock` now resolves halo2_gadgets 0.5.0
  only.
- this one was DEEPER — the note-domain scanner fix, without which the
  wallet cannot see the ironwood pool at all, plus the regtest harnesses
  that caught it.

- source repo: zcli, branch `master` (merged), rev `8274f4e`
- sha256(zafu_wasm_bg.wasm) = 8148c338eb5991888d856e6b0d5fe93136d7579da09cd3ab7fa263c0fda3cc73
- toolchain: **wasm-bindgen 0.2.126** (CHANGED from 0.2.114), binaryen 123

  The wasm-bindgen move was NOT deliberate. `crates/zcash-wasm/Cargo.toml`
  carries a caret constraint (`"0.2.113"`), so regenerating `Cargo.lock`
  let it float. It cannot be pinned back without cascading downgrades:
  `js-sys` 0.3.103 requires `wasm-bindgen = "=0.2.126"` exactly. The CLI was
  moved to match, because bindgen refuses when the schema version baked into
  the .wasm and the CLI version differ — which is how this was noticed at
  all. If you want the old toolchain back, that is a dependency-graph
  decision, not a CLI one.

Verified after copying:

- all three blobs byte-identical: sha256 `8148c338…`
- shared imported memory confirmed by parsing the import section: flags
  `0x03`, max 32768 pages
- full rayon export set present (`initThreadPool`, `wbg_rayon_start_worker`,
  `__wbindgen_thread_destroy`, `__tls_base`)
- export surface unchanged at 69 functions
- snippets patched in BOTH trees; zero live `import('../../..')` remain
- `tsc` clean, 354 tests pass, `pnpm build` green, blob present 4x across
  `dist/` and `beta-dist/` with no superseded blob surviving anywhere
- BOTH regtest gates re-run by hand against the merged tree: ironwood
  (t→z, z→t) and turnstile (orchard→ironwood), `1 passed` each

NOT verified: no mainnet broadcast. The extension has never been loaded in
a browser with this blob.

## 2026-08-06 rebuild — upstream crates (fork dropped)

Rebuilt after zcli moved off the `valargroup/librustzcash` and `zcash/orchard`
forks onto upstream crates.io releases. Until this rebuild the extension was
still executing fork-built code: the migration did not reach zafu at all,
because these blobs are the only thing the workers load.

- source repo: zcli, branch `feat/upstream-crates`
- source rev: `cb5136a` — "fix(scan): trial-decrypt both note-version domains"
  on top of `ae896c0` "feat(deps): drop librustzcash/orchard forks".

  **The intermediate blob built from `ae896c0` alone was BROKEN and must never
  be shipped.** Upstream orchard 0.15.5 splits the note-encryption domain by
  note version and ENFORCES it: `OrchardDomain` accepts only V2 plaintexts
  (lead byte 0x02), `IronwoodDomain` only V3 (0x03). The fork had one
  permissive domain and the scanner relied on that, so every ironwood note
  failed to decrypt — silently, returning `None` rather than erroring. A wallet
  built from `ae896c0` reads zero balance for the entire live pool and cannot
  spend its own notes.

  Nothing caught this except a real validator: 288 unit tests, clean clippy, a
  verified wasm build and 4/4 consensus fixtures all passed while it was live.
  The transaction is perfectly valid; it is the wallet's ability to recognise
  its OWN output that broke. `cb5136a` fixes the scanner to trial-decrypt both
  domains and adds unit coverage that reproduces it without a node.

- upstream versions: orchard 0.15.5, pczt 0.9.2, zcash_primitives 0.30.0,
  zcash_protocol 0.10.4, zcash_keys 0.16.1, zcash_transparent 0.10.0,
  zcash_address 0.13.0. No git deps; `vendor/librustzcash` and the `[patch]`
  block are gone.
- the `zcash_unstable = "nu6.3"` cfg is GONE and must not come back: NU6.3 is
  fully ungated upstream. The `link-args` array in `.cargo/config.toml` is
  unchanged and still load-bearing (see the warning above).
- sha256(zafu_wasm_bg.wasm) = 842948d27204b1bde9edaffa81d24eb8e8bc3f7578761b814165c797615e5702
- toolchain: wasm-bindgen 0.2.114, binaryen/wasm-opt 123 (identical to the
  previous entry, so a size/shape diff would indicate a real code change)

Build commands: the PARALLEL recipe below, unchanged.

Verified after copying:

- all three blobs byte-identical: sha256 `842948d2…`
- shared imported memory confirmed by parsing the binary's import section
  directly: `./zafu_wasm_bg.js` `memory`, flags `0x03` (shared), max 32768
  pages = 2147483648 bytes
- export profile compared against the previous known-good blob and found
  IDENTICAL, including the full rayon set (`initThreadPool`,
  `wbg_rayon_start_worker`, `__wbindgen_thread_destroy`, `__tls_base`).
  Note: post-bindgen only `__tls_base` appears; `__wasm_init_tls`/`__tls_size`/
  `__tls_align` are present pre-bindgen and are consumed by the glue. That is
  normal — the previous shipped blob has exactly the same profile, so do not
  treat their absence here as a dropped link-arg.
- `zafu_wasm.js` and `zafu_wasm.d.ts` regenerated BYTE-IDENTICAL to the
  previous build: the fork→upstream move is ABI-neutral at the wasm boundary,
  so no TypeScript changes were required. Export surface verified unchanged at
  69 functions. (An intermediate build lost 66 lines of `.d.ts` doc comment
  because the scanner fix was inserted INSIDE `frost_parse_tx_outputs`' doc
  block, silently reassigning that doc to a private helper. Corrected before
  shipping; a glue delta of any kind is worth chasing down rather than
  waving through.)
- regenerated `snippets/` were byte-identical to the shipped ones once the
  Chrome worker patch was re-applied to BOTH trees (`wbgRayonBase` defined
  AND used; zero live `import('../../..')` statements remain).

VERIFIED ON A REAL VALIDATOR: the ironwood money paths were run end to end
against a local zebrad 6.2.3 Regtest chain (NU6.3 live from block 1) via
`deploy/regtest/run-ironwood-e2e.sh` in zcli. t→z shielding and z→t withdrawal
were both ACCEPTED and MINED, the note decrypted back out of the mined block,
the ZIP-317 fee recomputed from the mined bytes agreed at 15,000 zat, and a
replayed withdrawal was refused — so the nullifier really was consumed.

NOT verified: no MAINNET transaction was broadcast from this blob. The
turnstile path (orchard → ironwood) is not exercised by the regtest e2e and
still wants a mainnet round-trip against its known-good reference at block
3,436,797.

## 2026-08-05 rebuild — ironwood shielding

Rebuilt so `build_shielding_transaction_ironwood` (t->z into the NU6.3 pool)
is actually reachable from the extension; the merge that added it to
crates/zcash-wasm did NOT ship a wasm, so zafu could not call it.

Corrections to this file, both found the hard way:

- `apps/extension/public/zafu-wasm-parallel/` no longer exists. There are
  TWO consumers, not three.
- BOTH shipped copies are the PARALLEL build. The heading below still calls
  `packages/zcash-wasm/` single-thread; it is not, and shipping a
  single-thread blob there would break rayon proving.

Verified after copying:

- all three files (zafu*wasm_bg.wasm, the zcash*\* duplicate, and the
  public/ copy) are byte-identical: sha256 1ebdc4b5215f1227...
- `(import "./zafu_wasm_bg.js" "memory" (memory ... shared))` present
- the Chrome worker patch re-applied to both `snippets/` trees
- `tsc --noEmit` clean, all four webpack configs compile

The one build warning (`workerHelpers.js:57`, expression dependency) is our
LOCAL PATCH and is expected.

toolchain: wasm-bindgen 0.2.114, binaryen/wasm-opt 123
