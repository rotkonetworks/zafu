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
 * * `consensus_branch_id` — branch id the host's node reports (lightwalletd).
 *   It must have the Ironwood pool (NU6.3 or later, NU7 included), and so
 *   must the snapshot height. It only selects the note protocol: the PCZT is
 *   always built under TX1 v1's V6 / NU6.3 profile, the one the vote chain
 *   rebuilds the signed digest under.
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
 * Build the helper-share payloads (`[VoteShareWire]`, `POST {helper}/shielded-vote/v1/shares`)
 * for a vote that is already on chain.
 *
 * `commitment_bundle_json` is the recovery bundle `cast_vote_hot_wire`
 * returned for this vote; `vc_tree_position` is the vote commitment's leaf
 * index in the round's commitment tree, known once the cast-vote transaction
 * is included. No proof runs here, so the shares match the submitted
 * commitment.
 */
export function build_vote_shares_from_recovery(commitment_bundle_json: string, vc_tree_position: bigint, submit_at: bigint): string;

/**
 * Build the `POST /cast-vote` body plus what the host keeps for after it lands.
 *
 * Runs ZKP #2 once. Returns
 * `{ proposal_id, wire, commitment_bundle_json, next_delegation_state_json }`.
 *
 * No helper shares come back from here: a share commits to the vote's leaf
 * index in the round's commitment tree (`vc_tree_position`), which only
 * exists once the cast-vote transaction is included. Shares built before
 * that carry a guessed position, and the helper's reveal for them never
 * matches the tree, so the vote silently drops out of the tally. Build them
 * with [`build_vote_shares_from_recovery`] from `commitment_bundle_json` and
 * the included position.
 *
 * `commitment_bundle_json` holds the share secrets (it can rebuild shares,
 * which carry `vote_decision`): store it encrypted.
 *
 * `next_delegation_state_json` is this bundle's state for its next cast
 * (this proposal's authority bit cleared). Store it only after the cast is
 * on chain: if the cast never lands, the old state is still the valid one,
 * and a cleared bit would lock the proposal out of a retry.
 */
export function cast_vote_hot_wire(hotkey_secret_hex: string, round_params_json: string, delegation_state_json: string, van_witness_json: string, vote_json: string, network: string): string;

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

export function initThreadPool(num_threads: number): Promise<any>;

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
    readonly build_delegation_pczt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number) => [number, number, number, number];
    readonly build_vote_commitment_wire: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly build_vote_shares_from_recovery: (a: number, b: number, c: bigint, d: bigint) => [number, number, number, number];
    readonly cast_vote_hot_wire: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly finalize_delegation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly generate_voting_hotkey: (a: number, b: number) => [number, number, number, number];
    readonly pir_fetch_imt_proofs: (a: number, b: number, c: number, d: number, e: any) => any;
    readonly voting_wasm_init_panic_hook: () => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => any;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly wasm_bindgen_80140066f03354e2___convert__closures_____invoke___wasm_bindgen_80140066f03354e2___JsValue__core_a76ab548e90a171e___result__Result_____wasm_bindgen_80140066f03354e2___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_80140066f03354e2___convert__closures_____invoke___js_sys_22b816839ce642e1___Function_fn_wasm_bindgen_80140066f03354e2___JsValue_____wasm_bindgen_80140066f03354e2___sys__Undefined___js_sys_22b816839ce642e1___Function_fn_wasm_bindgen_80140066f03354e2___JsValue_____wasm_bindgen_80140066f03354e2___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_80140066f03354e2___convert__closures_____invoke___wasm_bindgen_80140066f03354e2___JsValue______true_: (a: number, b: number, c: any) => void;
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
