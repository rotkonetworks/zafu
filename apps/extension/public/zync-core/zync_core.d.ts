/* tslint:disable */
/* eslint-disable */

/**
 * Orchard activation height
 */
export function activation_height(mainnet: boolean): number;

/**
 * Compute merkle root for a block's actions.
 *
 * Input: binary packed actions `[count_u32_le] [cmx(32) | nullifier(32) | epk(32)] * count`
 * Returns: hex-encoded 32-byte root
 */
export function compute_actions_root(actions_binary: Uint8Array): string;

/**
 * Cross-verification endpoints as JSON array
 */
export function crossverify_endpoints(mainnet: boolean): string;

/**
 * Blocks per epoch
 */
export function epoch_size(): number;

/**
 * Extract enc_ciphertext from raw V5 transaction bytes for a specific action.
 *
 * Returns hex-encoded 580-byte ciphertext, or empty string if not found.
 */
export function extract_enc_ciphertext(raw_tx: Uint8Array, cmx_hex: string, epk_hex: string): string;

/**
 * Compare two block hashes accounting for LE/BE byte order differences.
 */
export function hashes_match(a_hex: string, b_hex: string): boolean;

export function initThreadPool(num_threads: number): Promise<any>;

/**
 * Initialize rayon thread pool for WASM parallel execution
 * Must be called once before using parallel scanning in WASM
 *
 * Usage from JavaScript:
 * ```javascript
 * import init, { initThreadPool } from './zync_core.js';
 * await init();
 * await initThreadPool(navigator.hardwareConcurrency);
 * ```
 */
export function init_thread_pool(num_threads: number): Promise<any>;

/**
 * Update running actions commitment chain.
 *
 * Returns hex-encoded 32-byte commitment.
 */
export function update_actions_commitment(prev_hex: string, actions_root_hex: string, height: number): string;

/**
 * Verify actions commitment chain matches proven value.
 *
 * Throws on mismatch (server tampered with block actions).
 */
export function verify_actions_commitment(running_hex: string, proven_hex: string, has_saved_commitment: boolean): string;

/**
 * Verify a single NOMT commitment proof (note exists in tree).
 */
export function verify_commitment_proof(cmx_hex: string, tree_root_hex: string, path_proof: Uint8Array, value_hash_hex: string): boolean;

/**
 * Verify a header proof and extract proven NOMT roots.
 *
 * Returns JSON: `{ "tree_root": "hex", "nullifier_root": "hex", "actions_commitment": "hex" }`
 * Throws on invalid proof.
 */
export function verify_header_proof(proof_bytes: Uint8Array, tip: number, mainnet: boolean): string;

/**
 * Verify a single NOMT nullifier proof (spent/unspent).
 */
export function verify_nullifier_proof(nullifier_hex: string, nullifier_root_hex: string, is_spent: boolean, path_proof: Uint8Array, value_hash_hex: string): boolean;

/**
 * Initialize panic hook for better error messages in browser console
 */
export function wasm_init(): void;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly activation_height: (a: number) => number;
    readonly compute_actions_root: (a: number, b: number) => [number, number, number, number];
    readonly crossverify_endpoints: (a: number) => [number, number];
    readonly epoch_size: () => number;
    readonly extract_enc_ciphertext: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly hashes_match: (a: number, b: number, c: number, d: number) => number;
    readonly update_actions_commitment: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly verify_actions_commitment: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly verify_commitment_proof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly verify_header_proof: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly verify_nullifier_proof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly wasm_init: () => void;
    readonly init_thread_pool: (a: number) => any;
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => any;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
