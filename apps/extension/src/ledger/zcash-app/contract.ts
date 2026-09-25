/**
 * Contract for Ledger SHIELDED support via the Ledger Zcash app (3.9.x,
 * Orchard + Ironwood), replacing the transparent-only legacy Bitcoin-app path
 * (../hw-btc-*.ts) for new accounts.
 *
 * Reference implementation: vizor-wallet (chainapsis) rust/src/wallet/ledger/
 * and lib/src/features/ledger/, docs/ledger/. Same split, deliberately:
 *
 *   PROTOCOL (Rust, in zcli's zcash-wasm -> vendored @repo/zcash-wasm)
 *     builds the exact APDU commands for an operation and parses/validates the
 *     device's responses. It is the only thing that understands the Zcash app's
 *     wire format, PCZT serialization, limits and signatures.
 *
 *   TRANSPORT (TypeScript, WebHID, page context - side panel or tab, never the
 *   popup that tears down) only exchanges bytes: open the device, make sure the
 *   Zcash app is running, send commands in order, return raw responses. It never
 *   interprets a signature.
 *
 * Everything below is the seam between the pieces, so they can be built in
 * parallel. Change it only by agreement: every piece codes against it.
 */

/** One transport-neutral APDU command (vizor `LedgerApduCommand`). */
export interface ApduCommand {
  readonly cla: number;
  readonly ins: number;
  readonly p1: number;
  readonly p2: number;
  readonly data: Uint8Array;
}

/** Ledger Zcash app limits per transaction (vizor mod.rs, app 3.9.3+). */
export const LEDGER_ZCASH_LIMITS = {
  maxTransparentInputs: 32,
  maxTransparentOutputs: 10,
  /** per shielded pool (Orchard, Ironwood) */
  maxShieldedActions: 32,
} as const;

/** New accounts need this app version or newer (vizor: 3.9.4). */
export const MIN_ZCASH_APP_VERSION_FOR_NEW_ACCOUNTS = '3.9.4';
/** Accounts connected earlier may still sign with this (vizor: 3.9.3). */
export const MIN_ZCASH_APP_VERSION_FOR_SIGNING = '3.9.3';

/** What the device is running right now. */
export interface LedgerDeviceApp {
  /** 'Zcash' when the app is open; a dashboard name ('BOLOS' / 'OLOS') otherwise. */
  readonly name: string;
  readonly version: string;
}

/** Account material the user approved on the device. */
export interface LedgerAccountExport {
  readonly ufvk: string;
  readonly seedFingerprint: Uint8Array;
  readonly accountIndex: number;
}

/** A spend authorization signature from the device. pool 0 = Orchard, 1 = Ironwood. */
export interface LedgerActionSig {
  readonly pool: 0 | 1;
  readonly actionIndex: number;
  /** 64 bytes */
  readonly sig: Uint8Array;
}

/**
 * Distinct failure kinds. The UI tells the user what to DO for each, so they
 * must never collapse into one "ledger error" (vizor ledger_error_codes.dart).
 */
export type LedgerFailure =
  | 'not_connected' // no device / WebHID permission not granted
  | 'locked' // device PIN screen
  | 'app_not_open' // on the dashboard or another app; ask to open Zcash
  | 'app_too_old' // below the version this operation needs
  | 'rejected' // user rejected on the device
  | 'busy' // another operation holds the device
  | 'unsupported_transaction' // over limits, or a path the app cannot sign
  | 'cancelled' // host cancelled; the device prompt may still be showing
  | 'protocol_error'; // malformed / unexpected response

export class LedgerError extends Error {
  constructor(
    readonly failure: LedgerFailure,
    message?: string,
    readonly statusWord?: number,
  ) {
    super(message ?? failure);
    this.name = 'LedgerError';
  }
}

/**
 * PROTOCOL half. Implemented by wasm exports added to zcli's zcash-wasm
 * (ported from vizor), wrapped in ./protocol.ts. Pure: no I/O.
 */
export interface LedgerZcashProtocol {
  /** APDUs that export the UFVK for `accountIndex` (vizor: first + continuation). */
  ufvkPlan(accountIndex: number): ApduCommand[];
  parseUfvk(
    responses: Uint8Array[],
    network: 'main' | 'test',
    accountIndex: number,
  ): LedgerAccountExport;
  /**
   * Throws LedgerError('unsupported_transaction') when the PCZT exceeds
   * LEDGER_ZCASH_LIMITS or spends legacy Orchard into Ironwood (unsupported by
   * the current app), BEFORE anything reaches the device.
   */
  validatePczt(pczt: Uint8Array): void;
  /** Full signing plan: the device signs transparent inputs and shielded actions. */
  pcztSigningPlan(pczt: Uint8Array, opts: { memoHashSupported: boolean }): ApduCommand[];
  /** Validate the responses and return the PCZT with every signature applied. */
  finalizePcztSigning(pczt: Uint8Array, responses: Uint8Array[]): Uint8Array;
}

/** Progress events the signing UI renders (vizor signing-phase-guidance.md). */
export type LedgerSigningPhase =
  | { phase: 'connecting' }
  | { phase: 'open_app' } // waiting for the user to open the Zcash app
  | { phase: 'sending'; sent: number; total: number }
  | { phase: 'review' } // the device is showing the transaction; waiting for approve/reject
  | { phase: 'done' };

/**
 * TRANSPORT half: WebHID, implemented in ./transport-webhid.ts. Exchanges bytes;
 * interprets only status words (to raise LedgerError kinds).
 */
export interface LedgerZcashDevice {
  /** Which app is open. Never opens one. */
  currentApp(): Promise<LedgerDeviceApp>;
  /** Ask the device to open the Zcash app; resolves once it is running. */
  openZcashApp(opts?: { signal?: AbortSignal }): Promise<LedgerDeviceApp>;
  /**
   * Send `plan` in order, return each raw response (status word stripped).
   * One operation at a time: a second call while one runs throws 'busy'.
   * Waits for the post-signing screen to clear before any follow-up command.
   */
  exchange(
    plan: ApduCommand[],
    opts?: { signal?: AbortSignal; onPhase?: (p: LedgerSigningPhase) => void },
  ): Promise<Uint8Array[]>;
  close(): Promise<void>;
}

/**
 * A signed transaction waiting to be broadcast. Kept so a failed broadcast or
 * checkpoint retries WITHOUT asking the Ledger to approve again (vizor
 * operations.rs). Stored encrypted with the wallet's other secrets.
 */
export interface LedgerSignedOperation {
  readonly operationId: string;
  readonly walletId: string;
  readonly kind: 'send' | 'shield';
  readonly signedTxHex: string;
  readonly state: 'signed' | 'broadcast_uncertain' | 'broadcast' | 'acknowledged';
  readonly txid?: string;
  readonly createdAt: number;
}
