/**
 * Ledger transparent (t->t) send - the ship-today Ledger flow.
 *
 * Transparent->transparent is untouched by the NU6.3 turnstile (that only bites
 * when adding value INTO a shielded pool), so it works on the CURRENT released
 * app with no new wasm: Ledger's `signTransaction` (btc-style legacy path) BUILDS
 * and SIGNS the whole transparent tx and returns the signed hex; zafu just
 * gathers the UTXOs, hands them over, and broadcasts the result.
 *
 * The exact `LegacyCreateTransactionArg` wire format (prev-tx bytes per input,
 * outputScript packing, expiryHeight) is btc-derived and must be confirmed
 * against a real device / Speculos - marked TODO(device) below.
 */

import type {
  LegacyCreateTransactionArg,
  LegacyTransaction,
} from '@ledgerhq/device-signer-kit-zcash';
import { getZcashSigner } from './transport';
import { runDeviceAction } from './da-util';
import { hexToBytes } from './hex';

function coinType(mainnet: boolean): number {
  return mainnet ? 133 : 1;
}

/** Transparent derivation path (no "m/" prefix): 44'/coin'/account'/0/0. */
export function transparentPath(accountIndex: number, mainnet: boolean): string {
  return `44'/${coinType(mainnet)}'/${accountIndex}'/0/0`;
}

/** Read the account's transparent (t1.../tm...) address from the device. */
export async function getLedgerTransparentAddress(
  accountIndex: number,
  mainnet: boolean,
): Promise<string> {
  const { signer } = await getZcashSigner();
  const out = await runDeviceAction(signer.getAddress(transparentPath(accountIndex, mainnet)));
  return out.address;
}

/** A transparent UTXO to spend, plus the full previous transaction the device
 *  needs to build its trusted input. `prevTxHex` = the complete prior tx bytes. */
export interface LedgerUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly valueZat: number;
  /** full previous transaction bytes (hex). For v5+ prev txs this is the wire
   *  form the device accepts as `serializedPreviousTransactionOverride`. */
  readonly prevTxHex: string;
  /** derivation path of the key that controls this UTXO. */
  readonly path: string;
}

/** A transparent output. `scriptPubKeyHex` is the recipient's P2PKH script. */
export interface LedgerOutput {
  readonly scriptPubKeyHex: string;
  readonly valueZat: number;
}

export interface LedgerTransparentSendParams {
  readonly utxos: readonly LedgerUtxo[];
  readonly outputs: readonly LedgerOutput[];
  /** change back to one of our transparent paths (Ledger appends the change out). */
  readonly changePath?: string;
  readonly blockHeight: number;
  /** 4-byte little-endian expiry height (zcash). */
  readonly expiryHeight?: Uint8Array;
  readonly mainnet: boolean;
}

/**
 * Pack outputs into the `outputScriptHex` the legacy signer expects:
 * varint(count) || for each: value(8, LE) || varint(scriptLen) || scriptPubKey.
 * TODO(device): confirm varint vs fixed-width count + endianness against a device.
 */
export function buildOutputScriptHex(outputs: readonly LedgerOutput[]): string {
  const parts: string[] = [];
  parts.push(varint(outputs.length));
  for (const o of outputs) {
    parts.push(u64le(o.valueZat));
    const script = o.scriptPubKeyHex;
    parts.push(varint(script.length / 2));
    parts.push(script);
  }
  return parts.join('');
}

/**
 * Build + sign a transparent t->t transaction on the device and return the
 * broadcast-ready signed tx hex. Reuses the same coinbase-data/marker handling
 * as configured mining on the device side.
 */
export async function ledgerTransparentSend(params: LedgerTransparentSendParams): Promise<string> {
  const { signer } = await getZcashSigner();

  const additionals = ['zcash'];
  const args: LegacyCreateTransactionArg = {
    // The SDK takes a PARSED LegacyTransaction, not a hex string. We only have
    // the full previous-tx bytes, so hand them over via
    // `serializedPreviousTransactionOverride`, which the SDK documents as "use
    // these bytes for the trusted-input APDUs instead of re-serializing from
    // inputs/outputs" - exactly the v5-prev-tx case. `version`/`inputs` are
    // required by the type but unused when the override is set.
    // TODO(device): confirm on Speculos that the override alone is sufficient
    // and that no `tree`/`nExpiryHeight` field is additionally consulted.
    inputs: params.utxos.map(u => {
      const prevTx: LegacyTransaction = {
        version: new Uint8Array(4),
        inputs: [],
        serializedPreviousTransactionOverride: hexToBytes(u.prevTxHex),
      };
      return [prevTx, u.vout, undefined, undefined] as [
        LegacyTransaction,
        number,
        string | null | undefined,
        number | null | undefined,
      ];
    }),
    associatedKeysets: params.utxos.map(u => u.path),
    changePath: params.changePath,
    outputScriptHex: buildOutputScriptHex(params.outputs),
    blockHeight: params.blockHeight,
    additionals,
    expiryHeight: params.expiryHeight,
  };

  return runDeviceAction(signer.signTransaction(args));
}

// -- tiny wire helpers --

export function varint(n: number): string {
  if (n < 0xfd) {
    return byte(n);
  }
  if (n <= 0xffff) {
    return 'fd' + u16le(n);
  }
  if (n <= 0xffffffff) {
    return 'fe' + u32le(n);
  }
  return 'ff' + u64le(n);
}
function byte(n: number): string {
  return (n & 0xff).toString(16).padStart(2, '0');
}
function u16le(n: number): string {
  return byte(n) + byte(n >> 8);
}
function u32le(n: number): string {
  return u16le(n) + u16le(n >> 16);
}
export function u64le(n: number): string {
  // n is a zatoshi amount; safe within Number for realistic values.
  const lo = n >>> 0;
  const hi = Math.floor(n / 0x100000000) >>> 0;
  return u32le(lo) + u32le(hi);
}
