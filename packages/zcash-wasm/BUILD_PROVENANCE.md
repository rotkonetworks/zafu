# zcash-wasm build provenance

These vendored .wasm blobs are build artifacts. Do NOT hand-edit.
Reproduce by checking out the zcli rev below and running the commands.

- source repo: zcli-ironwood (branch feat/ironwood-cli)
- source rev: f87adee (feat(zcli): port zecli to NU6.3/Ironwood fork stack) PLUS
  uncommitted crates/zcash-wasm/src/lib.rs changes adding build_signed_ironwood_send
  (HOT-wallet local V6 signed ironwood send) AND build_ironwood_send_pczt (COLD
  zigner/watch-only redacted ironwood-send PCZT builder; sibling of
  build_turnstile_migration_pczt, leaves ironwood spends unsigned for the cold
  device). Both security-reviewed against the shared proven core.
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
    sha256(zafu_wasm_bg.wasm) = e627c9748a6d00a7bf18cbe13962b5852cbe471a4ff82f0e9179ca1ef035f5fb

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
    sha256(zafu_wasm_bg.wasm) = 7a856f5251dd78848783e8ef28407dcea08a91669cd59f2c5e790b6006c0ce2c

    Verify the rebuilt blob has shared imported memory before shipping:
      `(import "./zafu_wasm_bg.js" "memory" (memory ... shared))` post-bindgen.

    After copying pkg-parallel/* into apps/extension/public/zafu-wasm-parallel/,
    re-apply the LOCAL PATCH to snippets/wasm-bindgen-rayon-*/src/workerHelpers.js
    (stock `await import('../../..')` is a directory import that Chrome
    extensions reject; replace with the concrete `zafu_wasm.js` URL).

Verify: rebuild from the rev, sha256sum the outputs,
diff against the values above. A mismatch means the vendored blob is stale.
