/* tslint:disable */
/* eslint-disable */
/**
 * derive zcash unified full viewing key (ufvk) from mnemonic
 *
 * returns ufvk string (uview1...) for watch-only wallet import
 */
export function derive_zcash_ufvk(mnemonic: string, account: number, mainnet: boolean): string;
/**
 * derive zcash orchard full viewing key bytes from mnemonic
 *
 * returns 96-byte fvk as hex string
 */
export function derive_zcash_fvk_bytes(mnemonic: string, account: number): string;
/**
 * derive zcash unified address from a UFVK string (uview1... or uviewtest1...)
 *
 * used by watch-only wallets (zigner import) to display receive address
 */
export function address_from_ufvk(ufvk_str: string): string;
/**
 * derive zcash orchard address from mnemonic
 *
 * returns unified address (u1...) containing orchard receiver
 */
export function derive_zcash_address(mnemonic: string, account: number, mainnet: boolean): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly address_from_ufvk: (a: number, b: number) => [number, number, number, number];
  readonly derive_zcash_address: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly derive_zcash_fvk_bytes: (a: number, b: number, c: number) => [number, number, number, number];
  readonly derive_zcash_ufvk: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
