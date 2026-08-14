/**
 * Previous-transaction re-serialization for the Ledger legacy (btc-style)
 * transparent signing path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `LegacyTransaction.serializedPreviousTransactionOverride` is documented by
 * @ledgerhq/device-signer-kit-zcash as "full Zcash v5 wire form". That is
 * WRONG, and the device proves it: app-zcash's trusted-input parser does not
 * read the Zcash consensus encoding at all. It reads Ledger's own framing.
 *
 *   consensus v5 wire : version | nVersionGroupId | nConsensusBranchId |
 *                       lockTime | nExpiryHeight | vin | vout | <shielded>
 *
 *   what the app reads: version | nVersionGroupId | nConsensusBranchId |
 *                       varint(vin) | inputs | varint(vout) | outputs |
 *                       <3 zero shielded counts> | lockTime |
 *                       varint(len) | nExpiryHeight | extraData
 *
 * `src/parser.rs::parse_header` in app-zcash reads version, version group id,
 * branch id, then IMMEDIATELY a CompactSize input count - there is no lockTime
 * or nExpiryHeight in the header. Both trail the outputs (`parse_process_extra`).
 * Hand the device consensus bytes and it reads lockTime's first byte as the
 * input count and rejects the stream with 6a80 (INCORRECT_DATA).
 *
 * Device-verified on Speculos (nanosp, app-zcash 3.6.0): the same logical
 * transaction is rejected 6a80 in consensus framing and accepted 9000 in the
 * framing below. See `transparent.test.ts`.
 *
 * The signer-kit's own `serializeTransaction()` emits this framing only when
 * `(version & 0x7fffffff) === 4`, i.e. for v4 - a v5 header falls through to a
 * layout the device cannot parse. That is precisely why we override the bytes
 * rather than let the SDK serialize them.
 */

import { hexToBytes } from './hex';

/** Zcash v5 transaction header (`0x80000005`), little-endian on the wire. */
export const V5_TX_HEADER = 0x80000005;
/** Zcash v4 (Sapling) transaction header (`0x80000004`). */
export const V4_TX_HEADER = 0x80000004;
/** `nVersionGroupId` for v5 transactions. */
export const V5_VERSION_GROUP_ID = 0x26a7270a;

/**
 * Largest script app-zcash will accept, from its `consts.rs`
 * (`MAX_SCRIPT_SIZE = 1024 * 2`). Applies to input scripts and output scripts,
 * in both the trusted-input and the signing parser.
 */
export const DEVICE_MAX_SCRIPT_SIZE = 2048;

/** A transparent output recovered from a previous transaction. */
export interface LedgerPrevTxOutput {
  /** value in zatoshi */
  readonly valueZat: number;
  /** the `scriptPubKey` this output pays to */
  readonly scriptPubKey: Uint8Array;
}

/** A previous transaction converted into the framing the device parses. */
export interface LedgerPrevTx {
  /** bytes for `serializedPreviousTransactionOverride` */
  readonly serialized: Uint8Array;
  /** transparent outputs, in wire order - the SDK needs `outputs[vout].script` */
  readonly outputs: readonly LedgerPrevTxOutput[];
  /** the previous transaction's `nConsensusBranchId` */
  readonly consensusBranchId: number;
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  take(n: number, what: string): Uint8Array {
    if (n < 0 || this.remaining < n) {
      throw new Error(`prev tx truncated: wanted ${n} bytes for ${what}, ${this.remaining} left`);
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u32le(what: string): number {
    const b = this.take(4, what);
    return ((b[0]! | (b[1]! << 8) | (b[2]! << 16)) >>> 0) + b[3]! * 0x1000000;
  }

  u64le(what: string): number {
    const lo = this.u32le(what);
    const hi = this.u32le(what);
    const value = hi * 0x100000000 + lo;
    if (!Number.isSafeInteger(value)) {
      throw new Error(`prev tx ${what}: value exceeds Number.MAX_SAFE_INTEGER`);
    }
    return value;
  }

  /** Bitcoin/Zcash CompactSize. */
  varint(what: string): number {
    const first = this.take(1, what)[0]!;
    if (first < 0xfd) {
      return first;
    }
    if (first === 0xfd) {
      const b = this.take(2, what);
      return b[0]! | (b[1]! << 8);
    }
    if (first === 0xfe) {
      return this.u32le(what);
    }
    return this.u64le(what);
  }
}

function u32leBytes(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}

function u64leBytes(n: number): Uint8Array {
  const lo = n >>> 0;
  const hi = Math.floor(n / 0x100000000) >>> 0;
  return Uint8Array.of(...u32leBytes(lo), ...u32leBytes(hi));
}

/** CompactSize encoder (byte form of `transparent.ts`'s `varint`). */
export function compactSize(n: number): Uint8Array {
  if (n < 0xfd) {
    return Uint8Array.of(n);
  }
  if (n <= 0xffff) {
    return Uint8Array.of(0xfd, n & 0xff, (n >>> 8) & 0xff);
  }
  if (n <= 0xffffffff) {
    return Uint8Array.of(0xfe, ...u32leBytes(n));
  }
  return Uint8Array.of(0xff, ...u64leBytes(n));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Convert a Zcash **v5 consensus wire** transaction into the framing
 * app-zcash's `GET_TRUSTED_INPUT` parser reads, and recover its transparent
 * outputs.
 *
 * Fails closed - loudly, with the reason - rather than handing the device
 * bytes it will reject or, worse, misparse:
 *  - non-v5 transactions (v4 carries no `nConsensusBranchId` on the wire, so
 *    the device framing cannot be reconstructed without knowing the height)
 *  - transactions carrying Sapling or Orchard bundles (the device framing
 *    replaces the shielded sections with three zero counts; passing a shielded
 *    prev tx through it would make the device compute the WRONG txid, and a
 *    wrong txid silently produces a transaction that spends nothing)
 *  - scripts past the device's `MAX_SCRIPT_SIZE`
 */
export function zcashV5PrevTxToLedgerWire(wire: Uint8Array): LedgerPrevTx {
  const r = new Reader(wire);

  const header = r.u32le('header');
  if (header !== V5_TX_HEADER) {
    throw new Error(
      header === V4_TX_HEADER
        ? 'ledger prev tx: v4 previous transactions are not supported - the ' +
            'device framing needs an nConsensusBranchId, which a v4 tx does not ' +
            'carry on the wire'
        : `ledger prev tx: expected a v5 transaction header 0x${V5_TX_HEADER.toString(16)}, ` +
            `got 0x${header.toString(16)}`,
    );
  }

  const versionGroupId = r.u32le('nVersionGroupId');
  if (versionGroupId !== V5_VERSION_GROUP_ID) {
    throw new Error(
      `ledger prev tx: bad nVersionGroupId 0x${versionGroupId.toString(16)} ` +
        `(expected 0x${V5_VERSION_GROUP_ID.toString(16)})`,
    );
  }

  const consensusBranchId = r.u32le('nConsensusBranchId');
  const lockTime = r.take(4, 'lockTime');
  const expiryHeight = r.take(4, 'nExpiryHeight');

  // -- transparent inputs: passed through verbatim --
  const inputCount = r.varint('vin count');
  const inputParts: Uint8Array[] = [compactSize(inputCount)];
  for (let i = 0; i < inputCount; i++) {
    const prevout = r.take(36, `vin[${i}].prevout`);
    const scriptLen = r.varint(`vin[${i}].scriptSig length`);
    if (scriptLen > DEVICE_MAX_SCRIPT_SIZE) {
      throw new Error(
        `ledger prev tx: vin[${i}] scriptSig is ${scriptLen} bytes, device limit is ` +
          `${DEVICE_MAX_SCRIPT_SIZE}`,
      );
    }
    const script = r.take(scriptLen, `vin[${i}].scriptSig`);
    const sequence = r.take(4, `vin[${i}].sequence`);
    inputParts.push(prevout, compactSize(scriptLen), script, sequence);
  }

  // -- transparent outputs: passed through verbatim AND handed back parsed,
  //    because the SDK's SignTransactionTask reads outputs[vout].script to
  //    build the spent scriptPubKey for the sighash. --
  const outputCount = r.varint('vout count');
  const outputParts: Uint8Array[] = [compactSize(outputCount)];
  const outputs: LedgerPrevTxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    const valueZat = r.u64le(`vout[${i}].value`);
    const scriptLen = r.varint(`vout[${i}].scriptPubKey length`);
    if (scriptLen > DEVICE_MAX_SCRIPT_SIZE) {
      throw new Error(
        `ledger prev tx: vout[${i}] scriptPubKey is ${scriptLen} bytes, device limit is ` +
          `${DEVICE_MAX_SCRIPT_SIZE}`,
      );
    }
    const scriptPubKey = r.take(scriptLen, `vout[${i}].scriptPubKey`);
    outputParts.push(u64leBytes(valueZat), compactSize(scriptLen), scriptPubKey);
    outputs.push({ valueZat, scriptPubKey: Uint8Array.from(scriptPubKey) });
  }

  // -- shielded bundles must be empty; see the doc comment --
  const saplingSpends = r.varint('nSpendsSapling');
  const saplingOutputs = r.varint('nOutputsSapling');
  const orchardActions = r.remaining > 0 ? r.varint('nActionsOrchard') : 0;
  if (saplingSpends !== 0 || saplingOutputs !== 0 || orchardActions !== 0) {
    throw new Error(
      'ledger prev tx: previous transaction carries shielded bundles ' +
        `(sapling spends=${saplingSpends}, sapling outputs=${saplingOutputs}, ` +
        `orchard actions=${orchardActions}); the device trusted-input framing ` +
        'cannot represent them, so the txid it derives would be wrong',
    );
  }

  // -- Ledger framing --
  // The trailing `varint(len) | nExpiryHeight | extraData` block is what
  // `parse_process_extra` reads: it asserts `len === remaining`, then takes the
  // expiry height as a little-endian u32. The single 0x00 of extraData mirrors
  // what the signer-kit emits for non-sapling `additionals`.
  const extraData = Uint8Array.of(0x00);
  const serialized = concat([
    u32leBytes(header),
    u32leBytes(versionGroupId),
    u32leBytes(consensusBranchId),
    ...inputParts,
    ...outputParts,
    // nSpendsSapling | nOutputsSapling | nActionsOrchard, all zero
    Uint8Array.of(0x00, 0x00, 0x00),
    lockTime,
    compactSize(expiryHeight.length + extraData.length),
    expiryHeight,
    extraData,
  ]);

  return { serialized, outputs, consensusBranchId };
}

/** Hex convenience wrapper around {@link zcashV5PrevTxToLedgerWire}. */
export function prevTxHexToLedgerWire(prevTxHex: string): LedgerPrevTx {
  return zcashV5PrevTxToLedgerWire(hexToBytes(prevTxHex));
}
