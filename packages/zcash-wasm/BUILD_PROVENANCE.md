# zcash-wasm build provenance

## ⚠ THREE consumers — refresh ALL of them

A rebuild that updates only some copies ships a wallet whose worker and
prover disagree. This has bitten twice:

| path | loaded by | symptom when stale |
|---|---|---|
| `packages/zcash-wasm/` (`zafu_*` + duplicated `zcash_*`) | build-time package import | type/API drift |
| `apps/extension/public/zafu-wasm/` | the main compute worker | `X.compute_txid is not a function`; silently rebuilds txs with an old consensus constant |
| `apps/extension/public/zafu-wasm-parallel/` | the offscreen halo2 prover | proving fails or falls back to single-thread |

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
    sha256(zafu_wasm_bg.wasm) = b9a1c5298f283fde12e5eae075f0745d4400bc943f3d494f6e97a28a33b56d41

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
    sha256(zafu_wasm_bg.wasm) = fe73e27a8e31e27b45c6cc961ed9638afd6cfba37ffcb16e114ce11dda82db4a

    Verify the rebuilt blob has shared imported memory before shipping:
      `(import "./zafu_wasm_bg.js" "memory" (memory ... shared))` post-bindgen.

    After copying pkg-parallel/* into apps/extension/public/zafu-wasm-parallel/,
    re-apply the LOCAL PATCH to snippets/wasm-bindgen-rayon-*/src/workerHelpers.js
    (stock `await import('../../..')` is a directory import that Chrome
    extensions reject; replace with the concrete `zafu_wasm.js` URL).

Verify: rebuild from the rev, sha256sum the outputs,
diff against the values above. A mismatch means the vendored blob is stale.
