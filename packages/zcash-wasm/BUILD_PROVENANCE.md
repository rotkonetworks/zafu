# zcash-wasm build provenance

These vendored .wasm blobs are build artifacts. Do NOT hand-edit.
Reproduce by checking out the zcli rev below and running the commands.

- source repo: https://github.com/rotkonetworks/zcli (branch feat/NU6.2-lightwallet-endpoint-support)
- source rev:  eaa9878 (Merge branch 'staging' into feat/NU6.2-lightwallet-endpoint-support)
- source state: clean working tree
- built (UTC): 2026-06-05T15:28:00Z

## single-thread  (packages/zcash-wasm/zafu_wasm_bg.wasm; duplicated as zcash_wasm_bg.wasm)
    cd crates/zcash-wasm
    unset RUSTFLAGS
    RUSTUP_TOOLCHAIN=nightly cargo wasm-single
    wasm-bindgen ../../target/wasm32-unknown-unknown/release/zafu_wasm.wasm \
      --out-dir pkg --target web
    wasm-opt -Oz \
      --enable-simd --enable-bulk-memory --enable-mutable-globals \
      --enable-nontrapping-float-to-int \
      pkg/zafu_wasm_bg.wasm -o pkg/zafu_wasm_bg.wasm
    sha256(zafu_wasm_bg.wasm) = 84955a3ff9d002a9a079aca0470e5999aece2ef6814459a0fbcc0108c6616a95

## parallel / rayon  (apps/extension/public/zafu-wasm-parallel/zafu_wasm_bg.wasm)
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
    sha256(zafu_wasm_bg.wasm) = c6485874b15c56e30f4a95e48731a63f4b73210a7a3b8fd9b051617d43e7bc68

    Verify the rebuilt blob has shared imported memory before shipping:
      `(import "./zafu_wasm_bg.js" "memory" (memory ... shared))` post-bindgen.

    After copying pkg-parallel/* into apps/extension/public/zafu-wasm-parallel/,
    re-apply the LOCAL PATCH to snippets/wasm-bindgen-rayon-*/src/workerHelpers.js
    (stock `await import('../../..')` is a directory import that Chrome
    extensions reject; replace with the concrete `zafu_wasm.js` URL).

Verify: rebuild from the rev, sha256sum the outputs,
diff against the values above. A mismatch means the vendored blob is stale.
