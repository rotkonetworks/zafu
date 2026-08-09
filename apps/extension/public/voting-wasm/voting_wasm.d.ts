/* tslint:disable */
/* eslint-disable */

/**
 * Build the governance delegation PCZT for one bundle (phase 1 of 2).
 *
 * Args:
 * * `fvk_hex` — 96-byte Orchard FVK of the voter's account.
 * * `seed_fingerprint_hex` — 32-byte ZIP-32 seed fingerprint.
 * * `account_index` — ZIP-32 account index.
 * * `hotkey_pubkey_hex` — 43-byte hotkey raw Orchard address (from
 *   `generate_voting_hotkey`); the governance output target.
 * * `notes_json` — `[NoteInfoDto]` (the delegated notes).
 * * `round_params_json` — `RoundParamsDto`.
 * * `consensus_branch_id` — branch id at the snapshot height (host resolves via
 *   lightwalletd).
 * * `round_name` — display memo text.
 * * `network` — "mainnet" | "testnet" | "regtest".
 * * `bundle_index` — delegation bundle index (echoed into `delegation_state`).
 *
 * Returns `{ redacted_pczt_hex, pczt_sighash_hex, rk_hex, action_index,
 * delegated_weight, display_memo, real_note_nullifiers_hex, dummy_note_
 * nullifiers_hex, delegation_context_json, delegation_state_json }`.
 */
export function build_delegation_pczt(fvk_hex: string, seed_fingerprint_hex: string, account_index: number, hotkey_pubkey_hex: string, notes_json: string, round_params_json: string, consensus_branch_id: number, round_name: string, network: string, bundle_index: number): string;

/**
 * Build the `POST /cast-vote` body ([`VoteCommitmentWire`]) for one HOT vote.
 *
 * Binary fields are base64 STANDARD; `vote_round_id` is hex-decoded then
 * base64-encoded (matching `wire_codec`). Runs the ZKP #2 proof.
 */
export function build_vote_commitment_wire(hotkey_secret_hex: string, round_params_json: string, delegation_state_json: string, van_witness_json: string, vote_json: string, network: string): string;

/**
 * Build the helper-server share payloads (`[VoteShareWire]`) for one HOT vote.
 *
 * `submit_at` is the unix-seconds submission time stamped into each share.
 * Runs the ZKP #2 proof.
 */
export function build_vote_shares_wire(hotkey_secret_hex: string, round_params_json: string, delegation_state_json: string, van_witness_json: string, vote_json: string, network: string, submit_at: bigint): string;

/**
 * Build BOTH the commitment wire and share wires from a SINGLE proof run.
 *
 * Prefer this over calling the two builders separately: ZKP #2 is expensive and
 * each of `build_vote_commitment_wire` / `build_vote_shares_wire` runs it once.
 * Returns `SignedVoteCommitmentView`-shaped JSON
 * `{ proposal_id, wire, shares, commitment_bundle_json }`.
 */
export function cast_vote_hot_wire(hotkey_secret_hex: string, round_params_json: string, delegation_state_json: string, van_witness_json: string, vote_json: string, network: string, submit_at: bigint): string;

/**
 * Finalize delegation (phase 2 of 2): run ZKP #1 with host-injected IMT proofs
 * and attach the cold signer's spend-auth signature into the submission wire.
 *
 * Args:
 * * `delegation_context_json` — the opaque blob from `build_delegation_pczt`.
 * * `merkle_witnesses_json` — `[WitnessDto]`, one per note, in note order.
 * * `imt_proofs_json` — `[ImtProofDto]` covering BOTH the real note nullifiers
 *   and the `dummy_note_nullifiers_hex` reported by phase 1 (keyed by nullifier).
 * * `spend_auth_sig_hex` — 64-byte SpendAuth signature from the cold signer.
 * * `sighash_hex` — 32-byte sighash the signer signed (must equal the PCZT sighash).
 *
 * Returns `{ delegation_submission_wire_json }` — the `POST /delegate-vote` body.
 */
export function finalize_delegation(delegation_context_json: string, merkle_witnesses_json: string, imt_proofs_json: string, spend_auth_sig_hex: string, sighash_hex: string): string;

/**
 * Generate a fresh app-owned voting hotkey.
 *
 * Returns `{ hotkey_secret_hex, hotkey_pubkey_hex }` where `hotkey_secret_hex`
 * is the 64-byte stored secret (persist in secure storage) and
 * `hotkey_pubkey_hex` is the 43-byte raw Orchard address that the delegation
 * PCZT targets as the hotkey output (the hotkey's public identity).
 */
export function generate_voting_hotkey(network: string): string;

/**
 * Fetch circuit-ready IMT non-membership proofs for a set of nullifiers.
 *
 * `nullifiers_json` is a JSON array of 32-byte LE hex strings — the host passes
 * the UNION of the real-note nullifiers and the dummy-note nullifiers reported
 * by `build_delegation_pczt`. Resolves to a JSON `[ImtProofDto]` exactly as
 * `finalize_delegation` consumes it: `[{nullifier_hex, root_hex,
 * nf_bounds_hex[3], leaf_pos, path_hex[29]}]`.
 */
export function pir_fetch_imt_proofs(pir_base_url: string, nullifiers_json: string, js_fetch: Function): Promise<string>;

/**
 * Install a panic hook that forwards Rust panics to the JS console instead
 * of an opaque "unreachable executed" trap. Call once from JS after load.
 */
export function voting_wasm_init_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly build_delegation_pczt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number, number];
    readonly finalize_delegation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly build_vote_commitment_wire: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly build_vote_shares_wire: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: bigint) => [number, number, number, number];
    readonly cast_vote_hot_wire: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: bigint) => [number, number, number, number];
    readonly generate_voting_hotkey: (a: number, b: number) => [number, number, number, number];
    readonly voting_wasm_init_panic_hook: () => void;
    readonly pir_fetch_imt_proofs: (a: number, b: number, c: number, d: number, e: any) => any;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly wasm_bindgen_75fefa18e6030595___convert__closures_____invoke___wasm_bindgen_75fefa18e6030595___JsValue__core_2fb3c31ab891fe54___result__Result_____wasm_bindgen_75fefa18e6030595___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_75fefa18e6030595___convert__closures_____invoke___js_sys_9ec148cc023792e2___Function_fn_wasm_bindgen_75fefa18e6030595___JsValue_____wasm_bindgen_75fefa18e6030595___sys__Undefined___js_sys_9ec148cc023792e2___Function_fn_wasm_bindgen_75fefa18e6030595___JsValue_____wasm_bindgen_75fefa18e6030595___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_75fefa18e6030595___convert__closures_____invoke___js_sys_9ec148cc023792e2___futures__task__wait_async_polyfill__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_75fefa18e6030595___convert__closures_____invoke___wasm_bindgen_75fefa18e6030595___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
