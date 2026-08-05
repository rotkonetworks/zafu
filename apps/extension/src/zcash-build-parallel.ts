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

type WasmModule = Record<string, any>;

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

// Same blob the compute worker loads (public/zafu-wasm). They were separate
// directories holding byte-identical parallel builds — 6.3 MB shipped twice —
// and the duplication is what let one copy sit stale for two days. One path,
// one truth; each realm still gets its own module instance and rayon pool.
const WASM_BASE = '/zafu-wasm';

const initParallelWasm = async (): Promise<WasmModule> => {
  if (wasmModule) {
    return wasmModule;
  }
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
      const wasm = await import(/* webpackIgnore: true */ '/zafu-wasm/zafu_wasm.js');
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
  fn:
    | 'build_signed_spend'
    | 'build_unsigned'
    | 'build_unsigned_pczt'
    | 'build_turnstile_migration_pczt'
    | 'build_signed_turnstile_migration'
    | 'build_signed_ironwood_send'
    | 'build_ironwood_send_pczt'
    | 'build_shielding'
    | 'build_unsigned_shielding';
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
        a[0],
        a[1],
        a[2],
        BigInt(a[3] as string),
        BigInt(a[4] as string),
        a[5],
        a[6],
        a[7],
        a[8],
        a[9] ?? null,
        a[10] ?? null, // branch_id_hex (live consensus branch id; null -> WASM NU6.2 fallback)
      );
      break;

    case 'build_unsigned':
      result = wasm['build_unsigned_transaction'](
        a[0],
        a[1],
        a[2],
        BigInt(a[3] as string),
        BigInt(a[4] as string),
        a[5],
        a[6],
        a[7],
        a[8],
        a[9] ?? null,
        a[10] ?? null, // branch_id_hex (live consensus branch id; null -> WASM NU6.2 fallback)
      );
      break;

    case 'build_unsigned_pczt':
      // a[7] is target_height (number), not account_index
      result = wasm['build_unsigned_pczt'](
        a[0],
        a[1],
        a[2],
        BigInt(a[3] as string),
        BigInt(a[4] as string),
        a[5],
        a[6],
        a[7],
        a[8],
        a[9] ?? null,
      );
      break;

    case 'build_turnstile_migration_pczt':
      // NU6.3 turnstile (FIX-A signature): (ufvk, orchard_notes_json, fee,
      // orchard_anchor_hex, orchard_merkle_paths_json, account_index,
      // target_height, expected_branch_id, mainnet, memo_hex?) - a[2] is the fee
      // (stringified bigint over postMessage); a[7] is the fail-closed branch id.
      if (typeof wasm['build_turnstile_migration_pczt'] !== 'function') {
        throw new Error('ironwood turnstile not supported by this wasm build');
      }
      result = wasm['build_turnstile_migration_pczt'](
        a[0],
        a[1],
        BigInt(a[2] as string),
        a[3],
        a[4],
        a[5],
        a[6],
        a[7],
        a[8],
        a[9] ?? null,
      );
      break;

    case 'build_signed_turnstile_migration':
      // NU6.3 turnstile HOT path: same param layout as the cold
      // build_turnstile_migration_pczt above, but a[0] is the SEED PHRASE
      // (not the UFVK) and the wasm returns the final SIGNED V6 tx hex - no
      // intermediate PCZT is produced or persisted. Signature:
      // (seed_phrase, orchard_notes_json, fee, orchard_anchor_hex,
      //  orchard_merkle_paths_json, account_index, target_height,
      //  expected_branch_id, mainnet, memo_hex?). a[2] is the fee
      // (stringified bigint over postMessage); a[7] is the fail-closed branch id.
      if (typeof wasm['build_signed_turnstile_migration'] !== 'function') {
        throw new Error('ironwood hot-sign turnstile not supported by this wasm build');
      }
      result = wasm['build_signed_turnstile_migration'](
        a[0],
        a[1],
        BigInt(a[2] as string),
        a[3],
        a[4],
        a[5],
        a[6],
        a[7],
        a[8],
        a[9] ?? null,
      );
      break;

    case 'build_signed_ironwood_send':
      // NU6.3 general IRONWOOD hot send. Signature:
      // (seed_phrase, ironwood_notes_json, recipient, amount, fee,
      //  ironwood_anchor_hex, ironwood_merkle_paths_json, account_index,
      //  target_height, expected_branch_id, mainnet, memo_hex?). a[3]/a[4] are
      // the amount/fee (stringified bigint over postMessage); a[9] is the
      // fail-closed expected branch id (number). Feature-detected: the export
      // lands with the NU6.3 blob.
      if (typeof wasm['build_signed_ironwood_send'] !== 'function') {
        throw new Error('ironwood send not supported by this wasm build');
      }
      result = wasm['build_signed_ironwood_send'](
        a[0],
        a[1],
        a[2],
        BigInt(a[3] as string),
        BigInt(a[4] as string),
        a[5],
        a[6],
        a[7],
        a[8],
        a[9],
        a[10],
        a[11] ?? null,
      );
      break;

    case 'build_ironwood_send_pczt':
      // NU6.3 general IRONWOOD COLD send (zigner / watch-only). Same param
      // layout as build_signed_ironwood_send above, but a[0] is the UFVK (not
      // the seed) and the wasm returns a redacted-for-signer PCZT
      // { pczt_hex, summary, action_count } rather than a signed tx. Signature:
      // (ufvk_str, ironwood_notes_json, recipient, amount, fee,
      //  ironwood_anchor_hex, ironwood_merkle_paths_json, account_index,
      //  target_height, expected_branch_id, mainnet, memo_hex?). a[3]/a[4] are
      // the amount/fee (stringified bigint over postMessage); a[9] is the
      // fail-closed expected branch id (number). Feature-detected: the export
      // lands with the NU6.3 blob.
      if (typeof wasm['build_ironwood_send_pczt'] !== 'function') {
        throw new Error('ironwood cold send not supported by this wasm build');
      }
      result = wasm['build_ironwood_send_pczt'](
        a[0],
        a[1],
        a[2],
        BigInt(a[3] as string),
        BigInt(a[4] as string),
        a[5],
        a[6],
        a[7],
        a[8],
        a[9],
        a[10],
        a[11] ?? null,
      );
      break;

    case 'build_shielding':
      // Pool is resolved from the target height IN RUST, not here.
      // build_shielding_transaction (orchard) is now fail-closed at NU6.3:
      // shielding into orchard post-activation creates a note that cannot be
      // spent and needs a turnstile migration plus a second fee to recover.
      // _auto takes the same arguments and picks ironwood at/after activation,
      // so the stranded pool cannot be selected by omission.
      if (typeof wasm['build_shielding_transaction_auto'] !== 'function') {
        throw new Error(
          'this wasm build predates ironwood shielding - rebuild the wasm ' +
            '(see packages/zcash-wasm/BUILD_PROVENANCE.md); shielding into orchard ' +
            'after NU6.3 would strand the funds',
        );
      }
      result = wasm['build_shielding_transaction_auto'](
        a[0],
        a[1],
        a[2],
        BigInt(a[3] as string),
        BigInt(a[4] as string),
        a[5],
        a[6],
        a[7] ?? null, // branch_id_hex (live consensus branch id; required at NU6.3)
        a[8] ?? null, // memo_hex
      );
      break;

    case 'build_unsigned_shielding':
      result = wasm['build_unsigned_shielding_transaction'](
        a[0],
        a[1],
        BigInt(a[2] as string),
        BigInt(a[3] as string),
        a[4],
        a[5],
        a[6] ?? null, // branch_id_hex (live consensus branch id; null -> WASM NU6.2 fallback)
      );
      break;

    default:
      throw new Error(`unknown build function: ${req.fn}`);
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`[zcash-build-parallel] ${req.fn} done in ${elapsed}s`);
  return result;
}
