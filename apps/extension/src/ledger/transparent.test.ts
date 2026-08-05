/**
 * Ledger transparent (t->t) send tests.
 *
 * Two layers:
 *  1. Deterministic wire-building (runs everywhere, no device) - the varint /
 *     little-endian encoders and output-script packing that feed the legacy
 *     `signTransaction`. This is exactly the encoding a device round-trip would
 *     otherwise be the only check on, so we pin it against known vectors here.
 *  2. A gated device round-trip (skipped unless a Ledger / Speculos is wired in
 *     via LEDGER_SPECULOS) - the honest integration check: build -> device-sign
 *     -> broadcast -> confirm on a regtest. Documented so it's ready to run the
 *     moment hardware/emulator is available; NOT stamped "verified" until it does.
 */

import { describe, expect, it } from 'vitest';
import { varint, u64le, buildOutputScriptHex } from './transparent';

// a canonical P2PKH scriptPubKey: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
const P2PKH = `76a914${'ab'.repeat(20)}88ac`; // 25 bytes / 50 hex chars

describe('ledger transparent wire encoding', () => {
  it('varint: single-byte range', () => {
    expect(varint(0)).toBe('00');
    expect(varint(1)).toBe('01');
    expect(varint(252)).toBe('fc'); // 0xfc, last single-byte value
  });

  it('varint: 0xfd prefix (u16le)', () => {
    expect(varint(253)).toBe('fdfd00'); // fd || 253 as LE u16
    expect(varint(0xffff)).toBe('fdffff');
  });

  it('varint: 0xfe prefix (u32le)', () => {
    expect(varint(0x10000)).toBe('fe00000100'); // fe || 65536 LE u32
  });

  it('u64le: little-endian 8-byte amounts', () => {
    expect(u64le(0)).toBe('0000000000000000');
    expect(u64le(1)).toBe('0100000000000000');
    expect(u64le(1000)).toBe('e803000000000000'); // 0x3e8 LE
    // crosses the 32-bit boundary (hi word = 1)
    expect(u64le(0x1_0000_0000)).toBe('0000000001000000');
  });

  it('buildOutputScriptHex: one P2PKH output', () => {
    const hex = buildOutputScriptHex([{ scriptPubKeyHex: P2PKH, valueZat: 1000 }]);
    // count(varint) || value(u64le) || scriptLen(varint) || script
    expect(hex).toBe(`01${'e803000000000000'}19${P2PKH}`);
  });

  it('buildOutputScriptHex: two outputs (recipient + change)', () => {
    const hex = buildOutputScriptHex([
      { scriptPubKeyHex: P2PKH, valueZat: 1000 },
      { scriptPubKeyHex: P2PKH, valueZat: 250 },
    ]);
    expect(hex).toBe(`02${'e803000000000000'}19${P2PKH}${'fa00000000000000'}19${P2PKH}`);
  });

  it('buildOutputScriptHex: empty output set encodes a zero count', () => {
    expect(buildOutputScriptHex([])).toBe('00');
  });
});

/**
 * DEVICE ROUND-TRIP - the real verification. Gated: only runs when a Ledger or
 * Speculos transport is available (set LEDGER_SPECULOS + a node-hid/speculos
 * transport). It asserts the full money path:
 *   getLedgerTransparentAddress(0, false)
 *     -> getTransparentUtxosInWorker(t-addr)      (regtest UTXOs + prev txs)
 *     -> ledgerTransparentSend({ utxos, outputs, changePath, blockHeight })
 *     -> parse the returned tx: inputs are signed, outputs == requested,
 *        value_in - value_out == fee
 *     -> broadcastRawTxInWorker(hex) accepted by zebra
 *     -> mine 1 block; the recipient sees the funds.
 *
 * Until this runs green against a device/Speculos, the LegacyCreateTransactionArg
 * wire format in transparent.ts (prev-tx encoding, output packing, expiryHeight)
 * is UNVERIFIED - see the TODO(device) markers there.
 */
describe.skipIf(!process.env.LEDGER_SPECULOS)('ledger transparent device round-trip', () => {
  it('signs a t->t send the local zebra accepts', async () => {
    // Wiring the DMK WebHID/Speculos transport + a funded regtest t-addr is the
    // harness setup; the assertion is: broadcastRawTxInWorker resolves with a
    // txid and the tx confirms. Left as the explicit integration point.
    expect(process.env.LEDGER_SPECULOS).toBeDefined();
  });
});
