# zcash-wasm build provenance

## ⚠ TWO consumers — refresh BOTH of them

A rebuild that updates only some copies ships a wallet whose worker and
prover disagree. This has bitten twice:

| path                                                     | loaded by                 | symptom when stale                                                                       |
| -------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/zcash-wasm/` (`zafu_*` + duplicated `zcash_*`) | build-time package import | type/API drift; missing exports (e.g. shielding)                                         |
| `apps/extension/public/zafu-wasm/`                       | the main compute worker   | `X.compute_txid is not a function`; silently rebuilds txs with an old consensus constant |

⚠ 2026-08-07: the `zcash_*` duplicate in `packages/zcash-wasm/` was found STALE — its
wasm-bindgen symbol hashes differed from the binary while `zafu_wasm.js` matched, which
breaks `import('@repo/zcash-wasm')` with `Import #0 "./zafu_wasm_bg.js": module is not an
object or function`. The package `main`/`exports` now point at `zafu_wasm.js` and the
`zcash_*` duplicates were re-copied from `zafu_*` so all glues/binaries are byte-identical
again. Keep them identical on every refresh — a differing `zcash_*` glue is a landmine.

Both `public/` copies are the PARALLEL build (rayon `snippets/`, shared
memory). After copying either one, re-apply the Chrome worker patch and
verify `wbgRayonBase` is BOTH defined and used in
`snippets/*/src/workerHelpers.js` — patching only the call site leaves an
undefined reference that kills sub-workers silently.

Finally: `pnpm build` (NOT `pnpm bundle:prod`) so `dist/` and `beta-dist/`
both pick the new blobs up, then grep a known-new symbol in each.

These vendored .wasm blobs are build artifacts. Do NOT hand-edit.
Reproduce by checking out the zcli rev below and running the commands.

- source repo: zcli (master)
- source rev: 122451e — adds the enc_ciphertext->memo collapse to
  redact_pczt_compact, the largest request-leg win (2.53x vs 1.08x without).
- previous rev: 70722f7 — "Merge feat/compact-signer-redaction: wallet-side compact
  PCZT surface". Adds the compact-signing exports the wallet needs:
  `redact_pczt_compact`, `apply_signature_contributions`,
  `estimate_compact_savings`. Ironwood is UNGATED upstream now (pczt 0.9.x /
  zcash_primitives 0.30 / orchard 0.15.5) — build with NO
  `--cfg zcash_unstable` and no vendored fork.
- previous rev: 65c6ad6 — includes 59934d2 fix(consensus): real V6_VERSION_GROUP_ID
  0xD884B698 per ZIP-229 (the 0xFFFFFFFF placeholder made every v6 tx —
  ironwood migration + sends — fail zebrad broadcast with
  'expected TX_V6_VERSION_GROUP_ID'). Clean committed tree, no dirty state.
- source state: working tree has the above lib.rs changes staged/dirty; pkg/ + pkg-parallel/
  are build outputs. Commit lib.rs before treating these shas as reproducible.
- includes the final ironwood producer fixes: real branch id, spend-fvk redaction,
  output-recipient (wallet's own address) redaction on turnstile dummy outputs,
  and the build_signed_ironwood_send (hot) + build_ironwood_send_pczt (cold) producers.
- built (UTC): see git commit (Date is disabled in this environment)
- toolchain: wasm-bindgen 0.2.114, wasm-opt (binaryen) version 130
  (was 123; -Oz output differs byte-wise between binaryen versions, so the
  hashes below will not reproduce under 123)

## single-thread (packages/zcash-wasm/zafu_wasm_bg.wasm; duplicated as zcash_wasm_bg.wasm)

    cd crates/zcash-wasm
    unset RUSTFLAGS
    RUSTUP_TOOLCHAIN=nightly cargo wasm-single
    wasm-bindgen ../../target/wasm32-unknown-unknown/release/zafu_wasm.wasm \
      --out-dir pkg --target web
    wasm-opt -Oz \
      --enable-simd --enable-bulk-memory --enable-mutable-globals \
      --enable-nontrapping-float-to-int \
      pkg/zafu_wasm_bg.wasm -o pkg/zafu_wasm_bg.wasm
    sha256(zafu_wasm_bg.wasm) = 9c8ac43637d7d5a8442e131e6728dc33a4c02ac3ea05f5bd47e47bde124f8368

## parallel / rayon (apps/extension/public/zafu-wasm-parallel/zafu_wasm_bg.wasm)

    # DO NOT set RUSTFLAGS — env var overrides crates/zcash-wasm/.cargo/config.toml
    # rustflags wholesale, which drops the link-args (--shared-memory,
    # --import-memory, --max-memory, --export=__wasm_init_tls…). Without
    # those link-args the output has a private non-shared memory, rayon
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
    sha256(zafu_wasm_bg.wasm) = 67860fab0bdead4be5fe96631663cf18a1779d270511ef9588705e5598a909c8

    Verify the rebuilt blob has shared imported memory before shipping:
      `(import "./zafu_wasm_bg.js" "memory" (memory ... shared))` post-bindgen.

    After copying pkg-parallel/* into apps/extension/public/zafu-wasm-parallel/,
    re-apply the LOCAL PATCH to snippets/wasm-bindgen-rayon-*/src/workerHelpers.js
    (stock `await import('../../..')` is a directory import that Chrome
    extensions reject; replace with the concrete `zafu_wasm.js` URL).

Verify: rebuild from the rev, sha256sum the outputs,
diff against the values above. A mismatch means the vendored blob is stale.

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
