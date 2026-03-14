/**
 * Web Worker for rayon-based parallel Halo 2 proving (zcash).
 *
 * Runs inside the offscreen document. Initializes WASM with shared memory
 * and a rayon thread pool so halo2's MSM/FFT operations use all cores.
 * The proving key is built once (OnceLock) and stays cached.
 *
 * Mirrors the penumbra wasm-build-parallel.ts pattern.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WasmModule = Record<string, any>;

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

const initParallelWasm = async (): Promise<WasmModule> => {
  if (wasmModule) return wasmModule;
  if (initPromise) {
    await initPromise;
    return wasmModule!;
  }

  initPromise = (async () => {
    // @ts-expect-error dynamic import — parallel WASM build with rayon + shared memory
    const wasm = await import(/* webpackIgnore: true */ '/zafu-wasm-parallel/zafu_wasm.js');
    const memory = new WebAssembly.Memory({ initial: 43, maximum: 16384, shared: true });
    await wasm.default({ module_or_path: '/zafu-wasm-parallel/zafu_wasm_bg.wasm', memory });
    wasm.init();

    const numThreads = navigator.hardwareConcurrency || 4;
    await wasm.initThreadPool(numThreads);
    console.log(`[zcash-build-parallel] rayon: ${numThreads} threads`);

    wasmModule = wasm;
  })();

  try {
    await initPromise;
  } catch (e) {
    // allow retry on next call
    initPromise = null;
    throw e;
  }
  return wasmModule!;
};

interface ZcashBuildRequest {
  fn: 'build_signed_spend' | 'build_unsigned' | 'build_shielding' | 'build_unsigned_shielding';
  args: unknown[];
}

self.addEventListener('message', ({ data }: { data: ZcashBuildRequest }) => {
  void executeBuild(data).then(
    result => self.postMessage({ data: result }),
    error => self.postMessage({ error: { message: String(error) } }),
  );
});

async function executeBuild(req: ZcashBuildRequest): Promise<unknown> {
  const wasm = await initParallelWasm();
  const a = req.args;

  const start = performance.now();
  let result: unknown;

  switch (req.fn) {
    case 'build_signed_spend':
      // args: [mnemonic, notes, recipient, amount, fee, anchor, paths, accountIndex, mainnet]
      result = wasm['build_signed_spend_transaction'](
        a[0], a[1], a[2], BigInt(a[3] as string), BigInt(a[4] as string),
        a[5], a[6], a[7], a[8],
      );
      break;

    case 'build_unsigned':
      // args: [ufvk, notes, recipient, amount, fee, anchor, paths, accountIndex, mainnet]
      result = wasm['build_unsigned_transaction'](
        a[0], a[1], a[2], BigInt(a[3] as string), BigInt(a[4] as string),
        a[5], a[6], a[7], a[8],
      );
      break;

    case 'build_shielding':
      // args: [utxosJson, privkeyHex, recipient, amount, fee, anchorHeight, mainnet]
      result = wasm['build_shielding_transaction'](
        a[0], a[1], a[2], BigInt(a[3] as string), BigInt(a[4] as string),
        a[5], a[6],
      );
      break;

    case 'build_unsigned_shielding':
      // args: [utxosJson, recipient, amount, fee, anchorHeight, mainnet]
      result = wasm['build_unsigned_shielding_transaction'](
        a[0], a[1], BigInt(a[2] as string), BigInt(a[3] as string),
        a[4], a[5],
      );
      break;

    default:
      throw new Error(`unknown build function: ${req.fn}`);
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`[zcash-build-parallel] ${req.fn} done in ${elapsed}s`);
  return result;
}
