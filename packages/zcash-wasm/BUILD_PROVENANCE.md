# zcash-wasm build provenance

## ⚠ TWO consumers — refresh BOTH of them

A rebuild that updates only some copies ships a wallet whose worker and
prover disagree. This has bitten twice:

| path                                                     | loaded by                 | symptom when stale                                                                       |
| -------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/zcash-wasm/` (`zafu_*` + duplicated `zcash_*`) | build-time package import | type/API drift; missing exports (e.g. shielding)                                         |
| `apps/extension/public/zafu-wasm/`                       | the main compute worker   | `X.compute_txid is not a function`; silently rebuilds txs with an old consensus constant |

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
- source rev: 65c6ad6 — includes 59934d2 fix(consensus): real V6_VERSION_GROUP_ID
  0xD884B698 per ZIP-229 (the 0xFFFFFFFF placeholder made every v6 tx —
  ironwood migration + sends — fail zebrad broadcast with
  'expected TX_V6_VERSION_GROUP_ID'). Clean committed tree, no dirty state.
- source state: working tree has the above lib.rs changes staged/dirty; pkg/ + pkg-parallel/
  are build outputs. Commit lib.rs before treating these shas as reproducible.
- includes the final ironwood producer fixes: real branch id, spend-fvk redaction,
  output-recipient (wallet's own address) redaction on turnstile dummy outputs,
  and the build_signed_ironwood_send (hot) + build_ironwood_send_pczt (cold) producers.
- built (UTC): see git commit (Date is disabled in this environment)
- toolchain: wasm-bindgen 0.2.114, wasm-opt (binaryen) version 123

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
    sha256(zafu_wasm_bg.wasm) = 1ebdc4b5215f1227ffa05d08b1d9922f3de548f190773cbba15bae98e1072522

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
    sha256(zafu_wasm_bg.wasm) = 1ebdc4b5215f1227ffa05d08b1d9922f3de548f190773cbba15bae98e1072522

    Verify the rebuilt blob has shared imported memory before shipping:
      `(import "./zafu_wasm_bg.js" "memory" (memory ... shared))` post-bindgen.

    After copying pkg-parallel/* into apps/extension/public/zafu-wasm-parallel/,
    re-apply the LOCAL PATCH to snippets/wasm-bindgen-rayon-*/src/workerHelpers.js
    (stock `await import('../../..')` is a directory import that Chrome
    extensions reject; replace with the concrete `zafu_wasm.js` URL).

Verify: rebuild from the rev, sha256sum the outputs,
diff against the values above. A mismatch means the vendored blob is stale.

## 2026-08-06 rebuild (FINAL) — reconciled migration, merged to zcli master

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
