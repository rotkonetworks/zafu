/**
 * Shared-memory sizing for the vendored zafu-wasm module - single source of
 * truth for every loader that imports public/zafu-wasm/zafu_wasm.js with a
 * pre-allocated WebAssembly.Memory.
 *
 * ZAFU_WASM_INITIAL_PAGES must be >= the `initial` the wasm glue itself
 * declares (see `new WebAssembly.Memory({initial:N,...})` in
 * public/zafu-wasm/zafu_wasm.js). If it is smaller, instantiation throws
 * LinkError: "memory import has N pages which is smaller than the declared
 * initial of M" and address derivation breaks at runtime.
 *
 * A build-time assertion in webpack.config.ts (assertZafuWasmMemoryPages)
 * parses the glue file and FAILS THE BUILD if this constant is stale, so a
 * wasm re-vendor that grows the static footprint cannot ship a broken wallet.
 * When re-vendoring bumps the requirement, update this constant to match.
 */
export const ZAFU_WASM_INITIAL_PAGES = 59;

/** Matches the `maximum` declared by the zafu-wasm glue. */
export const ZAFU_WASM_MAXIMUM_PAGES = 32768;

/** Allocate the shared memory expected by zafu_wasm.js. */
export const createZafuWasmMemory = (): WebAssembly.Memory =>
  new WebAssembly.Memory({
    initial: ZAFU_WASM_INITIAL_PAGES,
    maximum: ZAFU_WASM_MAXIMUM_PAGES,
    shared: true,
  });
