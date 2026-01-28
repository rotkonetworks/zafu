/* tslint:disable */
/* eslint-disable */
/**
 * Get the commitment proof request data for a note
 * Returns the cmx that should be sent to zidecar's GetCommitmentProof
 */
export function get_commitment_proof_request(note_cmx_hex: string): string;
/**
 * Parse signatures from cold wallet QR response
 * Returns JSON with sighash and orchard_sigs array
 */
export function parse_signature_response(qr_hex: string): any;
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
 * Get number of threads available (0 if single-threaded)
 */
export function num_threads(): number;
/**
 * Create a PCZT sign request from transaction parameters
 * This is called by the online wallet to create the data that will be
 * transferred to the cold wallet via QR code.
 */
export function create_sign_request(account_index: number, sighash_hex: string, alphas_json: any, summary: string): string;
/**
 * Generate a new 24-word seed phrase
 */
export function generate_seed_phrase(): string;
/**
 * Initialize panic hook for better error messages
 */
export function init(): void;
/**
 * Validate a seed phrase
 */
export function validate_seed_phrase(seed_phrase: string): boolean;
/**
 * Complete a transaction by applying signatures from cold wallet
 * Returns the serialized signed transaction ready for broadcast
 */
export function complete_transaction(unsigned_tx_json: string, signatures_json: any): string;
/**
 * Get library version
 */
export function version(): string;
/**
 * Wallet keys derived from seed phrase
 */
export class WalletKeys {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the wallet's receiving address (identifier)
   */
  get_address(): string;
  /**
   * Get the Orchard FVK bytes (96 bytes) as hex
   */
  get_fvk_hex(): string;
  /**
   * Scan actions from JSON (legacy compatibility, slower)
   */
  scan_actions(actions_json: any): any;
  /**
   * Derive wallet keys from a 24-word BIP39 seed phrase
   */
  constructor(seed_phrase: string);
  /**
   * Calculate balance from found notes minus spent nullifiers
   */
  calculate_balance(notes_json: any, spent_nullifiers_json: any): bigint;
  /**
   * Export Full Viewing Key as hex-encoded QR data
   * This is used to create a watch-only wallet on an online device
   */
  export_fvk_qr_hex(account_index: number, label: string | null | undefined, mainnet: boolean): string;
  /**
   * Get the default receiving address as a Zcash unified address string
   */
  get_receiving_address(mainnet: boolean): string;
  /**
   * Scan a batch of compact actions in PARALLEL and return found notes
   * This is the main entry point for high-performance scanning
   */
  scan_actions_parallel(actions_bytes: Uint8Array): any;
  /**
   * Get receiving address at specific diversifier index
   */
  get_receiving_address_at(diversifier_index: number, mainnet: boolean): string;
  /**
   * Decrypt full notes with memos from a raw transaction
   *
   * Takes the raw transaction bytes (from zidecar's get_transaction)
   * and returns any notes that belong to this wallet, including memos.
   */
  decrypt_transaction_memos(tx_bytes: Uint8Array): any;
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
   * Is mainnet
   */
  is_mainnet(): boolean;
  /**
   * Import from hex-encoded QR data
   */
  static from_qr_hex(qr_hex: string): WatchOnlyWallet;
  /**
   * Get default receiving address (diversifier index 0)
   */
  get_address(): string;
  /**
   * Export FVK as hex bytes (for backup)
   */
  export_fvk_hex(): string;
  /**
   * Import a watch-only wallet from FVK bytes (96 bytes)
   */
  constructor(fvk_bytes: Uint8Array, account_index: number, mainnet: boolean);
  /**
   * Get address at specific diversifier index
   */
  get_address_at(diversifier_index: number): string;
  /**
   * Get account index
   */
  get_account_index(): number;
  /**
   * Scan compact actions (same interface as WalletKeys)
   */
  scan_actions_parallel(actions_bytes: Uint8Array): any;
  /**
   * Decrypt full notes with memos from a raw transaction (watch-only version)
   */
  decrypt_transaction_memos(tx_bytes: Uint8Array): any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_walletkeys_free: (a: number, b: number) => void;
  readonly __wbg_watchonlywallet_free: (a: number, b: number) => void;
  readonly build_unsigned_transaction: (a: any, b: number, c: number, d: bigint, e: bigint, f: number, g: number, h: any, i: number, j: number) => [number, number, number];
  readonly complete_transaction: (a: number, b: number, c: any) => [number, number, number, number];
  readonly create_sign_request: (a: number, b: number, c: number, d: any, e: number, f: number) => [number, number, number, number];
  readonly generate_seed_phrase: () => [number, number, number, number];
  readonly get_commitment_proof_request: (a: number, b: number) => [number, number, number, number];
  readonly num_threads: () => number;
  readonly parse_signature_response: (a: number, b: number) => [number, number, number];
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
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
