/**
 * zcash network integration
 *
 * uses zafu-wasm for key derivation and note scanning
 * connects to zidecar for trustless sync via grpc-web
 */

// types for zafu-wasm (loaded dynamically)
interface ZafuWasm {
  WalletKeys: new (seedPhrase: string) => WalletKeys;
  WatchOnlyWallet: {
    from_qr_hex(qrHex: string): WatchOnlyWallet;
    new (fvkBytes: Uint8Array, accountIndex: number, mainnet: boolean): WatchOnlyWallet;
  };
  initThreadPool(numThreads: number): Promise<void>;
  validate_seed_phrase(seedPhrase: string): boolean;
  generate_seed_phrase(): string;
  init(): void;
}

interface WalletKeys {
  get_address(): string;
  get_receiving_address(mainnet: boolean): string;
  get_receiving_address_at(diversifierIndex: number, mainnet: boolean): string;
  get_fvk_hex(): string;
  scan_actions_parallel(actionsBytes: Uint8Array): DecryptedNote[];
  calculate_balance(notesJson: unknown, spentNullifiersJson: unknown): bigint;
  export_fvk_qr_hex(accountIndex: number, label: string | null, mainnet: boolean): string;
  free(): void;
}

interface WatchOnlyWallet {
  get_address(): string;
  get_address_at(diversifierIndex: number): string;
  get_account_index(): number;
  is_mainnet(): boolean;
  export_fvk_hex(): string;
  scan_actions_parallel(actionsBytes: Uint8Array): DecryptedNote[];
  free(): void;
}

export interface DecryptedNote {
  height: number;
  txIndex: number;
  actionIndex: number;
  value: string; // zatoshis as string
  nullifier: string; // hex
  cmx: string; // hex
}

export interface ZcashSyncState {
  chainHeight: number;
  walletHeight: number;
  provenHeight: number;
  notes: DecryptedNote[];
  spentNullifiers: string[];
  balance: bigint;
}

let wasmModule: ZafuWasm | null = null;
let wasmInitialized = false;

/**
 * initialize zafu-wasm module
 * must be called before any other zcash functions
 */
export const initZcashWasm = async (): Promise<void> => {
  if (wasmInitialized) return;

  try {
    // dynamic import zafu-wasm from bundled location
    // webpack copies this to dist/zafu-wasm/
    // @ts-expect-error - dynamic import from extension root
    const wasm = await import(/* webpackIgnore: true */ '/zafu-wasm/zafu_wasm.js');
    await wasm.default('/zafu-wasm/zafu_wasm_bg.wasm');

    // init panic hook
    wasm.init();

    // init thread pool for parallel scanning
    const numThreads = navigator.hardwareConcurrency || 4;
    await wasm.initThreadPool(numThreads);

    wasmModule = wasm as ZafuWasm;
    wasmInitialized = true;

    console.log('[zcash] wasm initialized with', numThreads, 'threads');
  } catch (err) {
    console.error('[zcash] failed to init wasm:', err);
    throw err;
  }
};

/**
 * derive zcash address from mnemonic
 */
export const deriveZcashAddress = async (
  mnemonic: string,
  accountIndex = 0,
  mainnet = true,
): Promise<string> => {
  if (!wasmModule) {
    await initZcashWasm();
  }

  const keys = new wasmModule!.WalletKeys(mnemonic);
  try {
    return keys.get_receiving_address_at(accountIndex, mainnet);
  } finally {
    keys.free();
  }
};

/**
 * create watch-only wallet from FVK hex (for Zigner cold wallet)
 */
export const createWatchOnlyWallet = async (
  fvkHex: string,
  accountIndex: number,
  mainnet = true,
): Promise<WatchOnlyWallet> => {
  if (!wasmModule) {
    await initZcashWasm();
  }

  const fvkBytes = hexToBytes(fvkHex);
  return new wasmModule!.WatchOnlyWallet(fvkBytes, accountIndex, mainnet);
};

/**
 * import watch-only wallet from QR code hex
 */
export const importWatchOnlyFromQr = async (
  qrHex: string,
): Promise<WatchOnlyWallet> => {
  if (!wasmModule) {
    await initZcashWasm();
  }

  return wasmModule!.WatchOnlyWallet.from_qr_hex(qrHex);
};

/**
 * validate a seed phrase
 */
export const validateSeedPhrase = async (seedPhrase: string): Promise<boolean> => {
  if (!wasmModule) {
    await initZcashWasm();
  }

  return wasmModule!.validate_seed_phrase(seedPhrase);
};

// helper: hex to bytes
const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
};
