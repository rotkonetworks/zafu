/* tslint:disable */
/* eslint-disable */

/**
 * Wallet keys derived from seed phrase
 */
export class WalletKeys {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Calculate balance from found notes minus spent nullifiers
     */
    calculate_balance(notes_json: any, spent_nullifiers_json: any): bigint;
    /**
     * Decrypt full notes with memos from a raw transaction
     *
     * Takes the raw transaction bytes (from zidecar's get_transaction)
     * and returns any notes that belong to this wallet, including memos.
     */
    decrypt_transaction_memos(tx_bytes: Uint8Array): any;
    /**
     * Export Full Viewing Key as hex-encoded QR data
     * This is used to create a watch-only wallet on an online device
     */
    export_fvk_qr_hex(account_index: number, label: string | null | undefined, mainnet: boolean): string;
    /**
     * Derive wallet keys from a 24-word BIP39 seed phrase
     */
    constructor(seed_phrase: string);
    /**
     * Get the wallet's receiving address (identifier)
     */
    get_address(): string;
    /**
     * Get the Orchard FVK bytes (96 bytes) as hex
     */
    get_fvk_hex(): string;
    /**
     * Get the default receiving address as a Zcash unified address string
     */
    get_receiving_address(mainnet: boolean): string;
    /**
     * Get receiving address at specific diversifier index
     */
    get_receiving_address_at(diversifier_index: number, mainnet: boolean): string;
    /**
     * Scan actions from JSON (legacy compatibility, slower)
     */
    scan_actions(actions_json: any): any;
    /**
     * Scan a batch of compact actions in PARALLEL and return found notes
     * This is the main entry point for high-performance scanning
     */
    scan_actions_parallel(actions_bytes: Uint8Array): any;
}

/**
 * Watch-only wallet - holds only viewing keys, no spending capability
 * This is used by online wallets (Prax/Zafu) to track balances
 * and build unsigned transactions for cold signing.
 */
export class WatchOnlyWallet {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Decrypt full notes with memos from a raw transaction (watch-only version)
     */
    decrypt_transaction_memos(tx_bytes: Uint8Array): any;
    /**
     * Export FVK as hex bytes (for backup)
     */
    export_fvk_hex(): string;
    /**
     * Import a watch-only wallet from FVK bytes (96 bytes)
     */
    constructor(fvk_bytes: Uint8Array, account_index: number, mainnet: boolean);
    /**
     * Import from hex-encoded QR data
     */
    static from_qr_hex(qr_hex: string): WatchOnlyWallet;
    /**
     * Get account index
     */
    get_account_index(): number;
    /**
     * Get default receiving address (diversifier index 0)
     */
    get_address(): string;
    /**
     * Get address at specific diversifier index
     */
    get_address_at(diversifier_index: number): string;
    /**
     * Is mainnet
     */
    is_mainnet(): boolean;
    /**
     * Scan compact actions (same interface as WalletKeys)
     */
    scan_actions_parallel(actions_bytes: Uint8Array): any;
}

/**
 * Build merkle paths for note positions by replaying compact blocks from a checkpoint.
 *
 * # Arguments
 * * `tree_state_hex` - hex-encoded orchard frontier from GetTreeState
 * * `compact_blocks_json` - JSON array of `[{height, actions: [{cmx_hex}]}]`
 * * `note_positions_json` - JSON array of note positions `[position_u64, ...]`
 * * `anchor_height` - the block height to use as anchor
 *
 * # Returns
 * JSON `{anchor_hex, paths: [{position, path: [{hash}]}]}`
 */
export function build_merkle_paths(tree_state_hex: string, compact_blocks_json: string, note_positions_json: string, anchor_height: number): any;

/**
 * Build a shielding transaction (transparent → orchard) with real Halo 2 proofs.
 *
 * Spends transparent P2PKH UTXOs and creates an orchard output to the sender's
 * own shielded address. Uses `orchard::builder::Builder` for proper action
 * construction and zero-knowledge proof generation (client-side).
 *
 * Returns hex-encoded signed v5 transaction bytes ready for broadcast.
 *
 * # Arguments
 * * `utxos_json` - JSON array of `{txid, vout, value, script}` objects
 * * `privkey_hex` - hex-encoded 32-byte secp256k1 private key for transparent inputs
 * * `recipient` - unified address string (u1... or utest1...) for orchard output
 * * `amount` - total zatoshis to shield (all selected UTXO value minus fee)
 * * `fee` - transaction fee in zatoshis
 * * `anchor_height` - block height for expiry (expiry_height = anchor_height + 100)
 * * `mainnet` - true for mainnet, false for testnet
 */
export function build_shielding_transaction(utxos_json: string, privkey_hex: string, recipient: string, amount: bigint, fee: bigint, anchor_height: number, mainnet: boolean): string;

/**
 * Build a fully signed orchard spend transaction from a mnemonic wallet.
 *
 * Unlike `build_unsigned_transaction` (for cold signing), this function
 * derives the spending key from the mnemonic, constructs the full orchard
 * bundle with Halo 2 proofs, and returns a broadcast-ready transaction.
 *
 * # Arguments
 * * `seed_phrase` - BIP39 mnemonic for key derivation
 * * `notes_json` - JSON array of spendable notes with rseed/rho
 * * `recipient` - unified address string (u1... or utest1...)
 * * `amount` - zatoshis to send
 * * `fee` - transaction fee in zatoshis
 * * `anchor_hex` - merkle tree anchor (hex, 32 bytes)
 * * `merkle_paths_json` - JSON array of merkle paths from witness building
 * * `account_index` - ZIP-32 account index
 * * `mainnet` - true for mainnet, false for testnet
 *
 * # Returns
 * Hex-encoded signed v5 transaction bytes ready for broadcast
 */
export function build_signed_spend_transaction(seed_phrase: string, notes_json: any, recipient: string, amount: bigint, fee: bigint, anchor_hex: string, merkle_paths_json: any, account_index: number, mainnet: boolean): string;

/**
 * Build an unsigned transaction and return the data needed for cold signing
 * This is called by the online watch-only wallet.
 *
 * Returns JSON with:
 * - sighash: the transaction sighash (hex)
 * - alphas: array of alpha randomizers for each orchard action (hex)
 * - unsigned_tx: the serialized unsigned transaction (hex)
 * - summary: human-readable transaction summary
 */
export function build_unsigned_transaction(notes_json: any, recipient: string, amount: bigint, fee: bigint, anchor_hex: string, merkle_paths_json: any, account_index: number, _mainnet: boolean): any;

/**
 * Complete a transaction by applying signatures from cold wallet
 * Returns the serialized signed transaction ready for broadcast
 */
export function complete_transaction(unsigned_tx_json: string, signatures_json: any): string;

/**
 * Create a PCZT sign request from transaction parameters
 * This is called by the online wallet to create the data that will be
 * transferred to the cold wallet via QR code.
 */
export function create_sign_request(account_index: number, sighash_hex: string, alphas_json: any, summary: string): string;

/**
 * Derive transparent private key from mnemonic using BIP44 path m/44'/133'/account'/0/index
 *
 * Returns hex-encoded 32-byte secp256k1 private key for signing transparent inputs.
 * Path components: purpose=44' (BIP44), coin_type=133' (ZEC), account', change=0, index
 */
export function derive_transparent_privkey(seed_phrase: string, account: number, index: number): string;

/**
 * Compute the tree size from a hex-encoded frontier.
 */
export function frontier_tree_size(tree_state_hex: string): bigint;

/**
 * Generate a new 24-word seed phrase
 */
export function generate_seed_phrase(): string;

/**
 * Get the commitment proof request data for a note
 * Returns the cmx that should be sent to zidecar's GetCommitmentProof
 */
export function get_commitment_proof_request(note_cmx_hex: string): string;

/**
 * Initialize panic hook for better error messages
 */
export function init(): void;

export function initThreadPool(num_threads: number): Promise<any>;

/**
 * Get number of threads available (0 if single-threaded)
 */
export function num_threads(): number;

/**
 * Parse signatures from cold wallet QR response
 * Returns JSON with sighash and orchard_sigs array
 */
export function parse_signature_response(qr_hex: string): any;

/**
 * Compute the tree root from a hex-encoded frontier.
 */
export function tree_root_hex(tree_state_hex: string): string;

/**
 * Validate a seed phrase
 */
export function validate_seed_phrase(seed_phrase: string): boolean;

/**
 * Get library version
 */
export function version(): string;

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
    readonly __wbg_walletkeys_free: (a: number, b: number) => void;
    readonly __wbg_watchonlywallet_free: (a: number, b: number) => void;
    readonly build_merkle_paths: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly build_shielding_transaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: bigint, i: number, j: number) => [number, number, number, number];
    readonly build_signed_spend_transaction: (a: number, b: number, c: any, d: number, e: number, f: bigint, g: bigint, h: number, i: number, j: any, k: number, l: number) => [number, number, number, number];
    readonly build_unsigned_transaction: (a: any, b: number, c: number, d: bigint, e: bigint, f: number, g: number, h: any, i: number, j: number) => [number, number, number];
    readonly complete_transaction: (a: number, b: number, c: any) => [number, number, number, number];
    readonly create_sign_request: (a: number, b: number, c: number, d: any, e: number, f: number) => [number, number, number, number];
    readonly derive_transparent_privkey: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly frontier_tree_size: (a: number, b: number) => [bigint, number, number];
    readonly generate_seed_phrase: () => [number, number, number, number];
    readonly get_commitment_proof_request: (a: number, b: number) => [number, number, number, number];
    readonly parse_signature_response: (a: number, b: number) => [number, number, number];
    readonly tree_root_hex: (a: number, b: number) => [number, number, number, number];
    readonly validate_seed_phrase: (a: number, b: number) => number;
    readonly version: () => [number, number];
    readonly walletkeys_calculate_balance: (a: number, b: any, c: any) => [bigint, number, number];
    readonly walletkeys_decrypt_transaction_memos: (a: number, b: number, c: number) => [number, number, number];
    readonly walletkeys_export_fvk_qr_hex: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly walletkeys_from_seed_phrase: (a: number, b: number) => [number, number, number];
    readonly walletkeys_get_address: (a: number) => [number, number];
    readonly walletkeys_get_fvk_hex: (a: number) => [number, number];
    readonly walletkeys_get_receiving_address: (a: number, b: number) => [number, number];
    readonly walletkeys_get_receiving_address_at: (a: number, b: number, c: number) => [number, number];
    readonly walletkeys_scan_actions: (a: number, b: any) => [number, number, number];
    readonly walletkeys_scan_actions_parallel: (a: number, b: number, c: number) => [number, number, number];
    readonly watchonlywallet_decrypt_transaction_memos: (a: number, b: number, c: number) => [number, number, number];
    readonly watchonlywallet_export_fvk_hex: (a: number) => [number, number];
    readonly watchonlywallet_from_fvk_bytes: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly watchonlywallet_from_qr_hex: (a: number, b: number) => [number, number, number];
    readonly watchonlywallet_get_account_index: (a: number) => number;
    readonly watchonlywallet_get_address: (a: number) => [number, number];
    readonly watchonlywallet_get_address_at: (a: number, b: number) => [number, number];
    readonly watchonlywallet_is_mainnet: (a: number) => number;
    readonly watchonlywallet_scan_actions_parallel: (a: number, b: number, c: number) => [number, number, number];
    readonly init: () => void;
    readonly num_threads: () => number;
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
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
