/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const activation_height: (a: number) => number;
export const compute_actions_root: (a: number, b: number) => [number, number, number, number];
export const crossverify_endpoints: (a: number) => [number, number];
export const epoch_size: () => number;
export const extract_enc_ciphertext: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const hashes_match: (a: number, b: number, c: number, d: number) => number;
export const update_actions_commitment: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
export const verify_actions_commitment: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
export const verify_commitment_proof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
export const verify_header_proof: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const verify_nullifier_proof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
export const wasm_init: () => void;
export const init_thread_pool: (a: number) => any;
export const __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
export const initThreadPool: (a: number) => any;
export const wbg_rayon_poolbuilder_build: (a: number) => void;
export const wbg_rayon_poolbuilder_numThreads: (a: number) => number;
export const wbg_rayon_poolbuilder_receiver: (a: number) => number;
export const wbg_rayon_start_worker: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
