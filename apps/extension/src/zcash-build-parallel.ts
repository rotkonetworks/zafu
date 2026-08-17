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

import {
  assessAmbientRayonIsolation,
  RAYON_ISOLATION_WARNING,
} from './perf/rayon-isolation';

type WasmModule = Record<string, any>;

// Regression guard: rayon needs SharedArrayBuffer + a cross-origin-isolated
// context. Nothing sets COOP/COEP in this repo - Chrome grants shared memory in
// extension offscreen/worker realms by policy today. If that policy ever
// changes, initThreadPool silently builds a single-thread pool (proving ~5x
// slower) with no error. This shouts at each pool init so the regression is
// loud, not silent. Non-fatal: the single-thread fallback still runs.
const assertRayonIsolation = (tag: string): void => {
  const isolation = assessAmbientRayonIsolation();
  if (!isolation.ok) {
    console.error(`${RAYON_ISOLATION_WARNING} (${tag}: ${isolation.reason})`);
  }
};

let wasmModule: WasmModule | null = null;
let initPromise: Promise<void> | null = null;

// Same blob the compute worker loads (public/zafu-wasm). They were separate
// directories holding byte-identical parallel builds — 6.3 MB shipped twice —
// and the duplication is what let one copy sit stale for two days. One path,
// one truth; each realm still gets its own module instance and rayon pool.
const WASM_BASE = '/zafu-wasm';

// Standalone shielded-voting module (zcli crates/voting-wasm). Kept as a
// SEPARATE wasm instance and a SEPARATE rayon pool from the core module
// above - same reasoning as state/voting-wasm.ts: orchard/pczt/zcash_primitives
// must not co-version with the wallet scanner. Lazily initialized only when
// a voting proof request actually arrives, so the wallet's normal send/scan
// path never pays to load it.
let votingWasmModule: WasmModule | null = null;
let votingInitPromise: Promise<void> | null = null;
const VOTING_WASM_BASE = '/voting-wasm';

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

      assertRayonIsolation('zafu-wasm prover');
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

/**
 * How many rayon threads to spin up for voting proofs, capped for MEMORY SAFETY.
 *
 * Empirical basis (measured 2026-08-10, real K=14 delegation proof in headless
 * Chromium): the proof needs ~765 MB at 1 thread; each extra rayon worker
 * duplicates ~32 MB of per-thread proving-key state, so a 32-thread pool peaked
 * at ~1.76 GB - enough to OOM a low-RAM device. The speedup is SUB-LINEAR
 * (~4.7x at 32 threads on this small circuit), so past a handful of threads we
 * buy memory but almost no speed.
 *
 * Design: keep the estimated peak under a conservative slice of device RAM, with
 * a low absolute ceiling (diminishing returns) and a floor of 1. Every unknown
 * resolves TOWARD FEWER THREADS - navigator.deviceMemory is Chrome-only and
 * coarse (privacy-capped at 8 GB); if absent we assume a modest 4 GB, not an
 * optimistic large value. Worst case degrades to single-threaded, which the
 * caller's try/catch already handles.
 */
const votingProofThreads = (): number => {
  const cores = navigator.hardwareConcurrency || 4;
  const deviceMemGb = (navigator as { deviceMemory?: number }).deviceMemory || 4;
  const BASE_MB = 800; // 1-thread footprint, rounded up from ~765 MB measured
  const PER_THREAD_MB = 40; // per-extra-worker proving-key state, rounded up from ~32
  // Spend at most ~40% of device RAM on this pool; the rest is for the OS, the
  // browser, and the core wallet's own pool that shares this offscreen document.
  const budgetMb = deviceMemGb * 1024 * 0.4;
  const memCap = Math.max(1, Math.floor((budgetMb - BASE_MB) / PER_THREAD_MB) + 1);
  const CEILING = 6; // sub-linear scaling: beyond this buys memory, not speed
  return Math.max(1, Math.min(cores - 1, CEILING, memCap));
};

const initParallelVotingWasm = async (): Promise<WasmModule> => {
  if (votingWasmModule) {
    return votingWasmModule;
  }
  if (votingInitPromise) {
    await votingInitPromise;
    return votingWasmModule!;
  }

  votingInitPromise = (async () => {
    // Same Worker-URL patch as initParallelWasm above, applied around the
    // voting module's own init + initThreadPool call so its rayon pool's
    // sub-workers resolve against the extension origin too.
    const OriginalWorker = globalThis.Worker;
    const extOrigin = self.location.origin + '/';
    globalThis.Worker = class PatchedWorker extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        let urlStr = url instanceof URL ? url.href : String(url);
        if (!urlStr.startsWith(extOrigin) && !urlStr.startsWith('blob:')) {
          const relative = urlStr.startsWith('/') ? urlStr.slice(1) : urlStr;
          urlStr = extOrigin + relative;
          console.log('[zcash-build-parallel] patching voting worker URL →', urlStr);
        }
        super(urlStr, options);
      }
    };

    try {
      // @ts-expect-error dynamic import — parallel voting-wasm build with rayon + shared memory
      const wasm = await import(/* webpackIgnore: true */ '/voting-wasm/voting_wasm.js');
      await wasm.default({ module_or_path: `${VOTING_WASM_BASE}/voting_wasm_bg.wasm` });
      wasm.voting_wasm_init_panic_hook();

      // Own pool, independent of the core module's — same crossOriginIsolated
      // offscreen context, but a separate wasm instance/memory needs its own
      // initThreadPool call.
      assertRayonIsolation('voting-wasm prover');
      const numThreads = votingProofThreads();
      await wasm.initThreadPool(numThreads);
      console.log(
        `[zcash-build-parallel] voting-wasm rayon: ${numThreads} threads ` +
          `(cores=${navigator.hardwareConcurrency || '?'}, ` +
          `deviceMemory=${(navigator as { deviceMemory?: number }).deviceMemory ?? '?'}GB, ` +
          `memory-capped for OOM safety)`,
      );

      votingWasmModule = wasm;
    } finally {
      globalThis.Worker = OriginalWorker;
    }
  })();

  try {
    await votingInitPromise;
  } catch (e) {
    votingInitPromise = null;
    throw e;
  }
  return votingWasmModule!;
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
    | 'build_unsigned_shielding'
    | 'build_unsigned_shielding_ironwood'
    // shielded-voting proving fns (standalone voting-wasm module - see
    // initParallelVotingWasm above). build_delegation_pczt does not itself
    // run a halo2 proof (that's deferred to finalize_delegation) but is
    // routed through the offscreen prover anyway so all three share one
    // lazily-initialized voting-wasm instance + rayon pool instead of each
    // triggering its own load.
    | 'build_delegation_pczt'
    | 'finalize_delegation'
    | 'cast_vote_hot_wire';
  args: unknown[];
}

self.addEventListener('message', ({ data }: { data: ZcashBuildRequest }) => {
  void executeBuild(data).then(
    result => self.postMessage({ data: result }),
    error => self.postMessage({ error: { message: String(error) } }),
  );
});

// voting fns route to the standalone voting-wasm module + pool; everything
// else routes to the core zafu-wasm module + pool. Keeps the wallet's normal
// send/scan path from ever loading the voting module.
const VOTING_FNS = new Set<ZcashBuildRequest['fn']>([
  'build_delegation_pczt',
  'finalize_delegation',
  'cast_vote_hot_wire',
]);

async function executeBuild(req: ZcashBuildRequest): Promise<unknown> {
  const wasm = VOTING_FNS.has(req.fn) ? await initParallelVotingWasm() : await initParallelWasm();
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

    case 'build_unsigned_shielding_ironwood':
      // Cold/watch-only transparent -> IRONWOOD shielding (NU6.3+). Unlike the
      // orchard unsigned builder it takes the transparent pubkey_hex (a[1]) and
      // the numeric expected_branch_id (a[6]); the carrier in the returned
      // unsigned_tx_hex is a serialized PCZT, which complete_shielding_transaction
      // sniffs and routes to complete_shielding_pczt. Feature-detected.
      if (typeof wasm['build_unsigned_shielding_transaction_ironwood'] !== 'function') {
        throw new Error(
          'this wasm build predates ironwood cold shielding - rebuild the wasm ' +
            '(see packages/zcash-wasm/BUILD_PROVENANCE.md)',
        );
      }
      result = wasm['build_unsigned_shielding_transaction_ironwood'](
        a[0], // utxos_json
        a[1], // pubkey_hex (33-byte compressed, owns every UTXO)
        a[2], // recipient
        BigInt(a[3] as string),
        BigInt(a[4] as string),
        a[5], // target_height
        a[6], // expected_branch_id (number)
        a[7], // mainnet
        a[8] ?? null, // memo_hex
      );
      break;

    case 'build_delegation_pczt':
      // (fvk_hex, seed_fingerprint_hex, account_index, hotkey_pubkey_hex,
      //  notes_json, round_params_json, consensus_branch_id, round_name,
      //  network, bundle_index) — see voting-wasm/src/voting_delegation.rs.
      result = wasm['build_delegation_pczt'](
        a[0],
        a[1],
        a[2],
        a[3],
        a[4],
        a[5],
        a[6],
        a[7],
        a[8],
        a[9],
      );
      break;

    case 'finalize_delegation':
      // (delegation_context_json, merkle_witnesses_json, imt_proofs_json,
      //  spend_auth_sig_hex, sighash_hex) — runs the real K=14 ZKP #1 proof.
      result = wasm['finalize_delegation'](a[0], a[1], a[2], a[3], a[4]);
      break;

    case 'cast_vote_hot_wire':
      // (hotkey_secret_hex, round_params_json, delegation_state_json,
      //  van_witness_json, vote_json, network, submit_at) — runs ZKP #2.
      // submit_at crosses postMessage as a stringified bigint, same
      // convention as the amount/fee args on the core send builders above.
      result = wasm['cast_vote_hot_wire'](
        a[0],
        a[1],
        a[2],
        a[3],
        a[4],
        a[5],
        BigInt(a[6] as string),
      );
      break;

    default:
      throw new Error(`unknown build function: ${req.fn}`);
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.log(`[zcash-build-parallel] ${req.fn} done in ${elapsed}s`);
  return result;
}
