# zcash-wasm build provenance

These vendored .wasm blobs are build artifacts. Do NOT hand-edit.
Reproduce by checking out the zcli rev below and running the commands.

- source repo: zcli-ironwood (branch feat/ironwood-cli)
- source rev: f87adee (feat(zcli): port zecli to NU6.3/Ironwood fork stack) PLUS an
  uncommitted crates/zcash-wasm/src/lib.rs change adding build_signed_ironwood_send
  (hot-wallet local V6 signed ironwood send; security-reviewed, native round-trip tested).
- source state: working tree has the above lib.rs change staged/dirty; pkg/ + pkg-parallel/
  are build outputs. Commit lib.rs before treating these shas as reproducible.
- includes the final ironwood producer fixes: real branch id, spend-fvk redaction,
  output-recipient (wallet's own address) redaction on turnstile dummy outputs,
  and the new build_signed_ironwood_send producer.
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
    sha256(zafu_wasm_bg.wasm) = c4cafd8e1a05ade79fc101deab7b044cf621a3e9f54125e437c5a2c45ff6a242

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
    sha256(zafu_wasm_bg.wasm) = 16d790e22cc76ed94487aef5f68ed559a0e42e087ed5683cd69397d7ba00bca3

    Verify the rebuilt blob has shared imported memory before shipping:
      `(import "./zafu_wasm_bg.js" "memory" (memory ... shared))` post-bindgen.

    After copying pkg-parallel/* into apps/extension/public/zafu-wasm-parallel/,
    re-apply the LOCAL PATCH to snippets/wasm-bindgen-rayon-*/src/workerHelpers.js
    (stock `await import('../../..')` is a directory import that Chrome
    extensions reject; replace with the concrete `zafu_wasm.js` URL).

Verify: rebuild from the rev, sha256sum the outputs,
diff against the values above. A mismatch means the vendored blob is stale.
