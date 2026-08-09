/**
 * voting-wasm - lazy loader for the standalone shielded-voting WASM module.
 *
 * Kept SEPARATE from the core `zafu-wasm` module on purpose: `zcash_voting`
 * (+ `voting-circuits`) pulls its own orchard/pczt/zcash_primitives graph,
 * which must stay version-independent from the core wallet scanner/spender
 * (co-versioning previously caused digest-pin and sqlite/pool_migration
 * conflicts). The wallet never pays to load this - only the vote-cast UI
 * (`routes/popup/vote/zcash-vote-cast.tsx`, via the zcash worker's
 * `build-delegation-pczt` / `cast-vote-hot-wire` / etc. message handlers)
 * triggers the fetch, exactly like `ring-vrf.ts` does for pro membership
 * proofs.
 *
 * Source crate: zcli `crates/voting-wasm` (standalone cdylib, NOT part of
 * `crates/zcash-wasm`). See that crate's build-wasm.sh for the rebuild
 * recipe.
 *
 * IMPORTANT: this module declares SHARED memory
 * (`WebAssembly.Memory({shared: true})`), same as the core wallet's
 * parallel build, because `zcash_voting`'s `halo2_proofs` dependency has
 * `multicore` as a hard default feature that cannot be disabled from a
 * downstream crate - the wasm32 target therefore requires
 * `+atomics,+bulk-memory,+mutable-globals` codegen regardless of whether an
 * actual rayon thread pool is spun up.
 *
 * This lazy-loaded instance (used by the zcash worker directly, NOT via the
 * offscreen prover) is for the LIGHT voting fns only:
 * `generate_voting_hotkey` and `pir_fetch_imt_proofs` - neither runs a halo2
 * proof, so no thread pool is spun up here and proving-adjacent work stays
 * off the critical path of a network fetch. The three PROVING fns
 * (`build_delegation_pczt`, `finalize_delegation` - ZKP #1 - and
 * `cast_vote_hot_wire` - ZKP #2) are routed through a SEPARATE voting-wasm
 * instance in the offscreen document instead (see
 * `zcash-build-parallel.ts`'s `initParallelVotingWasm` /
 * `proveViaOffscreen` in `workers/zcash-worker.ts`), which DOES call
 * `initThreadPool` - halo2's K=14 delegation proof measured ~62s wall-clock
 * with a 32-thread pool there vs. ~290s single-threaded. The host context
 * still needs `crossOriginIsolated` (COOP/COEP) for the shared
 * `WebAssembly.Memory` allocation to succeed in either place - already true
 * of both the worker and offscreen contexts, so no extra header wiring
 * should be needed - verify in-browser before shipping.
 */

/** WASM module interface (lazy loaded). All heavy functions return JSON strings. */
export interface VotingWasm {
  voting_wasm_init_panic_hook: () => void;
  generate_voting_hotkey: (network: string) => string;
  build_delegation_pczt: (
    fvk_hex: string,
    seed_fingerprint_hex: string,
    account_index: number,
    hotkey_pubkey_hex: string,
    notes_json: string,
    round_params_json: string,
    consensus_branch_id: number,
    round_name: string,
    network: string,
    bundle_index: number,
  ) => string;
  finalize_delegation: (
    delegation_context_json: string,
    merkle_witnesses_json: string,
    imt_proofs_json: string,
    spend_auth_sig_hex: string,
    sighash_hex: string,
  ) => string;
  build_vote_commitment_wire: (
    hotkey_secret_hex: string,
    round_params_json: string,
    delegation_state_json: string,
    van_witness_json: string,
    vote_json: string,
    network: string,
  ) => string;
  build_vote_shares_wire: (
    hotkey_secret_hex: string,
    round_params_json: string,
    delegation_state_json: string,
    van_witness_json: string,
    vote_json: string,
    network: string,
    submit_at: bigint,
  ) => string;
  cast_vote_hot_wire: (
    hotkey_secret_hex: string,
    round_params_json: string,
    delegation_state_json: string,
    van_witness_json: string,
    vote_json: string,
    network: string,
    submit_at: bigint,
  ) => string;
  pir_fetch_imt_proofs: (
    pir_base_url: string,
    nullifiers_json: string,
    js_fetch: (input: string, init?: unknown) => unknown,
  ) => Promise<string>;
}

let wasmModule: VotingWasm | null = null;
let loadPromise: Promise<VotingWasm> | null = null;
let wasmFailed = false;

/**
 * Lazily load + initialize the voting WASM module. Safe to call
 * concurrently - callers share the same in-flight promise so the module is
 * only instantiated once (mirrors zcash-worker's `initWasm` `once` guard).
 */
export async function loadVotingWasm(): Promise<VotingWasm> {
  if (wasmModule) {
    return wasmModule;
  }
  if (wasmFailed) {
    throw new Error('voting-wasm unavailable');
  }
  if (loadPromise) {
    return loadPromise;
  }
  loadPromise = (async () => {
    try {
      // literal specifiers into /public break vitest's vite transform, so the
      // path lives in a variable - both bundlers then defer to runtime, same
      // trick as ring-vrf.ts.
      const wasmPath = '/voting-wasm/voting_wasm.js';
      const wasm = await import(/* webpackIgnore: true */ /* @vite-ignore */ wasmPath);
      await wasm.default({ module_or_path: '/voting-wasm/voting_wasm_bg.wasm' });
      wasm.voting_wasm_init_panic_hook();
      wasmModule = wasm as unknown as VotingWasm;
      return wasmModule;
    } catch (e) {
      wasmFailed = true;
      console.warn('[voting-wasm] load failed:', e);
      throw e;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

/** True once the module has been successfully loaded (for UI "priming" indicators). */
export function isVotingWasmReady(): boolean {
  return wasmModule !== null;
}
