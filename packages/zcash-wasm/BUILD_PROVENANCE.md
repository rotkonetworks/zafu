# zcash-wasm build provenance

These vendored .wasm blobs are build artifacts. Do NOT hand-edit.
Reproduce by checking out the zcli rev below and running the commands.

- source repo: https://github.com/rotkonetworks/zcli (branch staging)
- source rev:  686d174 (staging tip — `chore(staging): cap ur_decode_frames inputs`)
- source state: committed (rev above is an exact reproducibility anchor)
- built (UTC): 2026-06-04T11:21:00Z

## single-thread  (packages/zcash-wasm/zafu_wasm_bg.wasm; duplicated as zcash_wasm_bg.wasm)
    cd crates/zcash-wasm
    RUSTFLAGS='-C target-feature=+simd128' \
      wasm-pack build --release --target web --out-dir pkg --no-default-features
    sha256(zafu_wasm_bg.wasm) = dee6a25b604f27397522bbc3c8e143d96c18cfe24d435c3d2ac97ebbb164dfd3

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
    sha256(zafu_wasm_bg.wasm) = af3359357739b223804a9836ec00c0d2ef970d787627671e7cf0acb9ab923adf

    Verify the rebuilt blob has shared imported memory before shipping:
      `'env'.'memory' flags=0x03 shared=True` in the raw output;
      `'./zafu_wasm_bg.js'.'memory' flags=0x03 shared=True` post-bindgen.

    After copying pkg-parallel/* into apps/extension/public/zafu-wasm-parallel/,
    re-apply the LOCAL PATCH to snippets/wasm-bindgen-rayon-*/src/workerHelpers.js
    (stock `await import('../../..')` is a directory import that Chrome
    extensions reject; replace with the concrete `zafu_wasm.js` URL).

Verify: rebuild from the rev (+ this PR's crate diff), sha256sum the outputs,
diff against the values above. A mismatch means the vendored blob is stale.
