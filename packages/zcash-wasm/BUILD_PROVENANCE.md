# zcash-wasm build provenance

These vendored .wasm blobs are build artifacts. Do NOT hand-edit.
Reproduce by checking out the zcli rev below and running the commands.

- source repo: https://github.com/rotkonetworks/zcli (branch feat/pczt-builder)
- source rev:  2038eb6e1e91ba68c1bef9150596a978db9ec483
- source state: committed (rev above is an exact reproducibility anchor)
- built (UTC): 2026-05-16T21:03:54Z

## single-thread  (packages/zcash-wasm/zafu_wasm_bg.wasm; duplicated as zcash_wasm_bg.wasm)
    cd crates/zcash-wasm
    RUSTFLAGS='-C target-feature=+simd128' \
      wasm-pack build --release --target web --out-dir pkg --no-default-features
    sha256(zafu_wasm_bg.wasm) = 6b60bee7aeaaaec6746e78385eb926a388060ed10cc1d2f806aa6e5dbfd60199

## parallel / rayon  (apps/extension/public/zafu-wasm-parallel/zafu_wasm_bg.wasm)
    RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128' \
      cargo +nightly build -p zafu-wasm --lib --release \
      --target wasm32-unknown-unknown --features parallel \
      --no-default-features -Z build-std=panic_abort,std
    wasm-bindgen target/wasm32-unknown-unknown/release/zafu_wasm.wasm \
      --out-dir pkg-parallel --target web
    sha256(zafu_wasm_bg.wasm) = 98666ec742e4a617f4dc57096218e991eca90914e7c3ea5575316700060e3935

Verify: rebuild from the rev (+ this PR's crate diff), sha256sum the outputs,
diff against the values above. A mismatch means the vendored blob is stale.
