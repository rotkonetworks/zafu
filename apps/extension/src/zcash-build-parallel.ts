/**
 * Web Worker for rayon-based parallel Halo 2 proving (zcash).
 *
 * Runs inside the offscreen document. Initializes WASM with shared memory
 * and a rayon thread pool so halo2's MSM/FFT operations use all cores.
 * The proving key is built once (OnceLock) and stays cached.
 *
 * The key difference from penumbra's wasm-build-parallel.ts: the zcash WASM
 * is loaded from public/ via dynamic import (not webpack-bundled), so rayon's
 * workerHelpers.js can't resolve its nested Worker URLs via import.meta.url.
 * We patch the global Worker constructor to fix the URLs before init.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WasmModule = Record<string, any>;

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

const WASM_BASE = '/zafu-wasm-parallel';

const initParallelWasm = async (): Promise<WasmModule> => {
  if (wasmModule) return wasmModule;
  if (initPromise) {
    await initPromise;
    return wasmModule!;
  }

  initPromise = (async () => {
    // patch Worker constructor so rayon's workerHelpers.js can spawn sub-workers.
    // the helpers do `new Worker(new URL('./workerHelpers.js', import.meta.url), { type: 'module' })`
    // but import.meta.url in the offscreen context resolves wrong.
    // we intercept and rewrite the URL to the correct absolute extension path.
    // note: chrome.runtime is NOT available in nested Workers — use self.location.origin instead.
    const OriginalWorker = globalThis.Worker;
    const extOrigin = self.location.origin + '/';
    globalThis.Worker = class PatchedWorker extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        let urlStr = url instanceof URL ? url.href : String(url);
        // rayon's workerHelpers.js uses import.meta.url which resolves wrong
        // in extension offscreen context. ensure all worker URLs are absolute
        // chrome-extension:// paths.
        if (!urlStr.startsWith(extOrigin) && !urlStr.startsWith('blob:')) {
          // strip leading slash, make absolute
          const relative = urlStr.startsWith('/') ? urlStr.slice(1) : urlStr;
          urlStr = extOrigin + relative;
          console.log('[zcash-build-parallel] patching worker URL →', urlStr);
        }
        super(urlStr, options);
      }
    };

    try {
      // @ts-expect-error dynamic import — parallel WASM build with rayon + shared memory
      const wasm = await import(/* webpackIgnore: true */ '/zafu-wasm-parallel/zafu_wasm.js');
      // let the JS glue create shared memory with its own initial/max settings
      await wasm.default({ module_or_path: `${WASM_BASE}/zafu_wasm_bg.wasm` });
      wasm.init();

      const numThreads = navigator.hardwareConcurrency || 4;
      await wasm.initThreadPool(numThreads);
      console.log(`[zcash-build-parallel] rayon: ${numThreads} threads`);

      wasmModule = wasm;
    } finally {
      // restore original Worker constructor
      globalThis.Worker = OriginalWorker;
    }
  })();

  try {
    await initPromise;
  } catch (e) {
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
      result = wasm['build_signed_spend_transaction'](
        a[0], a[1], a[2], BigInt(a[3] as string), BigInt(a[4] as string),
        a[5], a[6], a[7], a[8], a[9] ?? null,
      );
      break;

    case 'build_unsigned':
      result = wasm['build_unsigned_transaction'](
        a[0], a[1], a[2], BigInt(a[3] as string), BigInt(a[4] as string),
        a[5], a[6], a[7], a[8], a[9] ?? null,
      );
      break;

    case 'build_shielding':
      result = wasm['build_shielding_transaction'](
        a[0], a[1], a[2], BigInt(a[3] as string), BigInt(a[4] as string),
        a[5], a[6],
      );
      break;

    case 'build_unsigned_shielding':
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
