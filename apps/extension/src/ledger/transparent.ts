/**
 * Ledger transparent (t->t) send - the ship-today Ledger flow.
 *
 * Transparent->transparent is untouched by the NU6.3 turnstile (that only bites
 * when adding value INTO a shielded pool), so it works on the CURRENT released
 * app with no new wasm: Ledger's `signTransaction` (btc-style legacy path) BUILDS
 * and SIGNS the whole transparent tx and returns the signed hex; zafu just
 * gathers the UTXOs, hands them over, and broadcasts the result.
 *
 * The `LegacyCreateTransactionArg` wire format was btc-derived guesswork. It has
 * now been driven against a real emulated device (Speculos, nanosp, app-zcash
 * 3.6.0 built from the `nanos+_1.6.1_3.6.0_sdk_v26.3.0` tag) and most of the
 * guesses were wrong. What changed, and what is now device-proven, is recorded
 * at each site below; `transparent.test.ts` re-runs the round trip.
 *
 * READ THIS BEFORE PLANNING AROUND IT: as of signer-kit 0.5.0 + app-zcash 3.6.0
 * this flow CANNOT complete, for reasons outside our encoders (see
 * `transparentSigningSupport`) - the branch id the kit derives at current
 * mainnet height is unknown to the app (6a80), and the kit's SIGN apdu is
 * shaped wrong for the app (6700). `ledgerTransparentSend` therefore fails
 * closed with the specific reason instead of emitting a doomed flow. Everything
 * below is what a working release will need, kept honest by the device tests.
 */

import type {
  LegacyCreateTransactionArg,
  LegacyTransaction,
} from '@ledgerhq/device-signer-kit-zcash';
import { getZcashSigner } from './transport';
import { runDeviceAction } from './da-util';
import { prevTxHexToLedgerWire, DEVICE_MAX_SCRIPT_SIZE, V5_TX_HEADER } from './prevtx';
import { transparentSigningSupport, APP_COMMITS_TO_EXPIRY_HEIGHT } from './capabilities';

/**
 * Most transparent outputs app-zcash's signing parser will accept, from its
 * `consts.rs` (`MAX_OUTPUTS_NUMBER = 8`, "due to device memory constraints").
 * Exceeding it aborts the flow mid-review with 6a80, after the user has already
 * been asked to approve - so we refuse before touching the device.
 */
export const DEVICE_MAX_OUTPUTS = 8;

export { DEVICE_MAX_SCRIPT_SIZE };

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
  /** the previous transaction in **Zcash v5 consensus wire form**. We convert it
   *  to the framing the device actually parses - see ./prevtx.ts. */
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
  /** zcash expiry height, as a HEIGHT. We encode it for the device; callers must
   *  not pre-encode it (the byte order is not the obvious one - see
   *  {@link expiryHeightBytes}). */
  readonly expiryHeight?: number;
  readonly mainnet: boolean;
}

/**
 * Pack outputs into the `outputScriptHex` the legacy signer expects:
 * varint(count) || for each: value(8, LE) || varint(scriptLen) || scriptPubKey.
 *
 * DEVICE-VERIFIED. app-zcash's `parser/output_parser.rs` reads exactly this:
 * `CompactSize` count, `Zatoshis::from_nonnegative_i64_le_bytes` over 8 bytes,
 * `CompactSize` script length, then the script. Driven through Speculos, the
 * device rendered "Output #1 amount 0.00150000 ZEC" plus the correct fee and
 * returned a signature.
 */
export function buildOutputScriptHex(outputs: readonly LedgerOutput[]): string {
  if (outputs.length > DEVICE_MAX_OUTPUTS) {
    throw new Error(
      `ledger: ${outputs.length} transparent outputs exceeds the device limit of ` +
        `${DEVICE_MAX_OUTPUTS} (app-zcash MAX_OUTPUTS_NUMBER)`,
    );
  }
  const parts: string[] = [];
  parts.push(varint(outputs.length));
  for (const o of outputs) {
    if (o.scriptPubKeyHex.length % 2 !== 0) {
      throw new Error('ledger: scriptPubKey hex has odd length');
    }
    const scriptLen = o.scriptPubKeyHex.length / 2;
    if (scriptLen > DEVICE_MAX_SCRIPT_SIZE) {
      throw new Error(
        `ledger: output scriptPubKey is ${scriptLen} bytes, device limit is ` +
          `${DEVICE_MAX_SCRIPT_SIZE} (app-zcash MAX_SCRIPT_SIZE)`,
      );
    }
    parts.push(u64le(o.valueZat));
    parts.push(varint(scriptLen));
    parts.push(o.scriptPubKeyHex);
  }
  return parts.join('');
}

/** Byte length of the expiry height field on the SIGN (0x48) APDU. */
export const EXPIRY_HEIGHT_BYTE_LENGTH = 4;

/**
 * Encode a zcash expiry height for the SIGN (0x48) APDU: 4 bytes, **BIG-endian**.
 *
 * This is not a typo and not the zcash wire order. `SignTransactionCommand`
 * appends this buffer verbatim, and app-zcash's `handlers/sign_tx.rs`
 * `parse_extra_data` reads it back with `u32::from_be_bytes(buf[5..9])` - the
 * app's own source comments the choice with "NOTE: for some reason big endian is
 * used here". `lockTime` on the same APDU is big-endian too (the signer kit
 * encodes it with `uint32ToBytesBE`).
 *
 * Note what this does NOT buy on app-zcash 3.6.0: the transparent signature does
 * not commit to this field at all (see `APP_COMMITS_TO_EXPIRY_HEIGHT`), so a
 * wrong byte order there is currently invisible rather than merely wrong. The
 * encoding is still the documented contract, and the moment the app starts
 * hashing the field a little-endian buffer becomes a byte-swapped commitment.
 */
export function expiryHeightBytes(height: number): Uint8Array {
  if (!Number.isInteger(height) || height < 0 || height > 0xffffffff) {
    throw new Error(`ledger: expiry height ${height} is not a u32`);
  }
  return Uint8Array.of(
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  );
}

/**
 * Build + sign a transparent t->t transaction on the device and return the
 * broadcast-ready signed tx hex.
 */
export async function ledgerTransparentSend(params: LedgerTransparentSendParams): Promise<string> {
  const { signer } = await getZcashSigner();

  // Fail closed on the consensus branch id BEFORE touching the money path. The
  // signer kit derives the branch id from blockHeight and no released app-zcash
  // recognises NU6.3, so at current mainnet height this flow cannot work at all
  // - and it would otherwise surface as an opaque 6a80 on the first APDU.
  const { major, minor, patch } = await runDeviceAction(signer.getAppConfig());
  const appVersion = `${major}.${minor}.${patch}`;
  const support = transparentSigningSupport(appVersion, params.blockHeight);
  if (!support.supported) {
    throw new Error(support.reason ?? `ledger zcash app ${appVersion} cannot sign transparent`);
  }

  if (params.utxos.length === 0) {
    throw new Error('ledger: no utxos to spend');
  }

  // A non-zero expiry height would go onto the wire but NOT into the signature
  // on any released app - the device computes the sighash before it is told the
  // expiry. Broadcasting that produces a transaction whose signature does not
  // cover its own expiry height, so refuse instead.
  if (!APP_COMMITS_TO_EXPIRY_HEIGHT && params.expiryHeight) {
    throw new Error(
      `ledger zcash app ${appVersion} does not commit to the expiry height when ` +
        'signing transparent inputs - it hashes the transaction before the SIGN ' +
        'apdu carries it, so the signature would not cover the expiry height. ' +
        'Use expiryHeight 0 (no expiry) or wait for an app release that fixes it.',
    );
  }

  const additionals = ['zcash'];
  const args: LegacyCreateTransactionArg = {
    // The SDK takes a PARSED LegacyTransaction. Two things are required and
    // both were wrong before, each proven against the device:
    //
    //  1. `serializedPreviousTransactionOverride` must carry LEDGER's framing,
    //     not the Zcash consensus wire form the SDK's own doc claims. Consensus
    //     bytes are rejected 6a80 on GET_TRUSTED_INPUT. See ./prevtx.ts.
    //
    //  2. `outputs` must be populated. The override only feeds the trusted-input
    //     APDUs; `SignTransactionTask.collectTrustedInputsAndOutputs` separately
    //     reads `outputs[vout].script` to build the spent scriptPubKey for the
    //     sighash, and rejects with "Invalid output index in previous
    //     transaction" when `outputs` is undefined - before emitting a single
    //     APDU. Passing the override alone could never have reached the device.
    inputs: params.utxos.map(u => {
      const prev = prevTxHexToLedgerWire(u.prevTxHex);
      const spent = prev.outputs[u.vout];
      if (!spent) {
        throw new Error(
          `ledger: utxo ${u.txid}:${u.vout} is out of range - the previous ` +
            `transaction has ${prev.outputs.length} outputs`,
        );
      }
      const prevTx: LegacyTransaction = {
        version: u32leBytes(V5_TX_HEADER),
        inputs: [],
        outputs: prev.outputs.map(o => ({
          amount: u64leBytes(o.valueZat),
          script: o.scriptPubKey,
        })),
        serializedPreviousTransactionOverride: prev.serialized,
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
    expiryHeight:
      params.expiryHeight === undefined ? undefined : expiryHeightBytes(params.expiryHeight),
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
function u32leBytes(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}
function u64leBytes(n: number): Uint8Array {
  const lo = n >>> 0;
  const hi = Math.floor(n / 0x100000000) >>> 0;
  return Uint8Array.of(...u32leBytes(lo), ...u32leBytes(hi));
}
