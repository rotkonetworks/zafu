/**
 * Ledger transparent (t->t) send tests.
 *
 * Two layers:
 *  1. Deterministic wire-building (runs everywhere, no device) - the varint /
 *     endianness encoders, output-script packing and previous-transaction
 *     re-framing that feed the legacy `signTransaction`. These pin the format
 *     so a regression is caught without hardware.
 *  2. A device round-trip against Speculos, gated on LEDGER_SPECULOS. This is
 *     the layer that actually decides whether our encoding is right: layer 1
 *     only ever proved we agree with ourselves, and every one of the three bugs
 *     this file now pins was invisible to it.
 *
 * The device suite SKIPS when no emulator answers - it must never pass without
 * one. See ./speculos.ts for how to bring an emulated device up.
 *
 * SCOPE OF THE DEVICE PROOF: the harness drives raw APDUs, so it validates our
 * byte encodings against the app's parser. It does not run
 * @ledgerhq/device-management-kit (WebHID-only, needs a browser), so DMK's own
 * APDU sequencing is still unverified.
 */

import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { describe, expect, it } from 'vitest';
import {
  varint,
  u64le,
  buildOutputScriptHex,
  expiryHeightBytes,
  DEVICE_MAX_OUTPUTS,
  DEVICE_MAX_SCRIPT_SIZE,
} from './transparent';
import { zcashV5PrevTxToLedgerWire, compactSize } from './prevtx';
import {
  branchForHeight,
  ledgerCapabilities,
  transparentSigningSupport,
  APP_COMMITS_TO_EXPIRY_HEIGHT,
  SIGNER_KIT_SIGN_APDU_COMPATIBLE,
  CONSENSUS_BRANCH_ID,
  NETWORK_UPGRADE_ACTIVATION,
} from './capabilities';
import { bytesToHex, hexToBytes } from './hex';
import {
  INS,
  encodeBip32Path,
  parseAppVersion,
  probeSpeculos,
  sendChunked,
  type SpeculosDevice,
} from './speculos';

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

describe('device limits are enforced before we touch the device', () => {
  // app-zcash consts.rs: MAX_OUTPUTS_NUMBER = 8, MAX_SCRIPT_SIZE = 1024 * 2.
  // Blowing these aborts the flow with 6a80 partway through the on-device
  // review, i.e. after the user has already been asked to approve.
  it('refuses more outputs than MAX_OUTPUTS_NUMBER', () => {
    const outputs = Array.from({ length: DEVICE_MAX_OUTPUTS }, () => ({
      scriptPubKeyHex: P2PKH,
      valueZat: 1,
    }));
    expect(() => buildOutputScriptHex(outputs)).not.toThrow();
    expect(() =>
      buildOutputScriptHex([...outputs, { scriptPubKeyHex: P2PKH, valueZat: 1 }]),
    ).toThrow(/exceeds the device limit of 8/);
  });

  it('refuses a scriptPubKey past MAX_SCRIPT_SIZE', () => {
    const tooBig = '00'.repeat(DEVICE_MAX_SCRIPT_SIZE + 1);
    expect(() => buildOutputScriptHex([{ scriptPubKeyHex: tooBig, valueZat: 1 }])).toThrow(
      /device limit is 2048/,
    );
  });
});

describe('expiry height encoding', () => {
  // app-zcash handlers/sign_tx.rs::parse_extra_data reads this field with
  // u32::from_be_bytes. The signer kit appends our buffer verbatim, so BE is
  // the contract even though the zcash wire format is little-endian.
  it('is big-endian, not the zcash wire order', () => {
    expect(bytesToHex(expiryHeightBytes(100000))).toBe('000186a0');
    expect(bytesToHex(expiryHeightBytes(0))).toBe('00000000');
    expect(bytesToHex(expiryHeightBytes(1))).toBe('00000001');
    expect(bytesToHex(expiryHeightBytes(0xffffffff))).toBe('ffffffff');
    // the mistake this pins: little-endian would be a0860100
    expect(bytesToHex(expiryHeightBytes(100000))).not.toBe('a0860100');
  });

  it('rejects values that are not a u32 height', () => {
    expect(() => expiryHeightBytes(-1)).toThrow();
    expect(() => expiryHeightBytes(1.5)).toThrow();
    expect(() => expiryHeightBytes(0x1_0000_0000)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// previous-transaction re-framing
// ---------------------------------------------------------------------------

function le32Hex(n: number): string {
  return bytesToHex(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff));
}

/** Build a v5 transaction in Zcash CONSENSUS wire form. */
function consensusV5({
  branchId = CONSENSUS_BRANCH_ID['nu6.2'],
  lockTime = 0,
  expiryHeight = 0,
  outputs = [{ value: 200000, script: P2PKH }],
  shielded = [0, 0, 0],
}: {
  branchId?: number;
  lockTime?: number;
  expiryHeight?: number;
  outputs?: { value: number; script: string }[];
  shielded?: number[];
} = {}): Uint8Array {
  const input = `${'00'.repeat(32)}0000000000ffffffff`; // outpoint | varint(0) script | sequence
  const outs = outputs.map(o => `${u64le(o.value)}${varint(o.script.length / 2)}${o.script}`).join('');
  return hexToBytes(
    '05000080' + // header 0x80000005 LE
      '0a27a726' + // nVersionGroupId 0x26a7270a LE
      le32Hex(branchId) +
      le32Hex(lockTime) +
      le32Hex(expiryHeight) +
      `01${input}` +
      `${varint(outputs.length)}${outs}` +
      shielded.map(n => bytesToHex(compactSize(n))).join(''),
  );
}

describe('previous transaction re-framing (serializedPreviousTransactionOverride)', () => {
  it('moves lockTime and expiry out of the header and onto the tail', () => {
    const wire = consensusV5({ lockTime: 0x11223344, expiryHeight: 0x55667788 });
    const { serialized, outputs, consensusBranchId } = zcashV5PrevTxToLedgerWire(wire);
    const hex = bytesToHex(serialized);

    // header is version | versionGroupId | branchId and then STRAIGHT into the
    // input count. This is the whole bug: consensus bytes put lockTime here, so
    // the device reads its first byte as the input count and rejects the stream.
    expect(hex.startsWith(`050000800a27a726${le32Hex(CONSENSUS_BRANCH_ID['nu6.2'])}01`)).toBe(true);

    // ...and the tail carries the three zero shielded counts, lockTime,
    // varint(len), the expiry height and one byte of extraData.
    expect(hex.endsWith('000000' + '44332211' + '05' + '88776655' + '00')).toBe(true);

    expect(consensusBranchId).toBe(CONSENSUS_BRANCH_ID['nu6.2']);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.valueZat).toBe(200000);
    expect(bytesToHex(outputs[0]!.scriptPubKey)).toBe(P2PKH);
  });

  it('recovers every transparent output, in wire order', () => {
    // SignTransactionTask reads outputs[vout].script for the sighash; leaving
    // `outputs` undefined makes it reject before it emits a single APDU.
    const other = `76a914${'cd'.repeat(20)}88ac`;
    const wire = consensusV5({
      outputs: [
        { value: 1, script: P2PKH },
        { value: 2, script: other },
        { value: 3, script: P2PKH },
      ],
    });
    const { outputs } = zcashV5PrevTxToLedgerWire(wire);
    expect(outputs.map(o => o.valueZat)).toEqual([1, 2, 3]);
    expect(bytesToHex(outputs[1]!.scriptPubKey)).toBe(other);
  });

  it('fails closed on a shielded previous transaction', () => {
    // The device framing has no room for sapling/orchard bundles, so the txid it
    // derives would be wrong - which silently produces a tx that spends nothing.
    expect(() => zcashV5PrevTxToLedgerWire(consensusV5({ shielded: [0, 0, 1] }))).toThrow(
      /carries shielded bundles/,
    );
  });

  it('fails closed on a v4 previous transaction', () => {
    // header 0x80000004 | nVersionGroupId 0x892f2085 | vin 0 | vout 0 | ...
    const v4 = hexToBytes('04000080' + '85202f89' + '00' + '00' + '00000000' + '00000000');
    expect(() => zcashV5PrevTxToLedgerWire(v4)).toThrow(
      /v4 previous transactions are not supported/,
    );
  });

  it('fails closed on truncated bytes rather than guessing', () => {
    const wire = consensusV5();
    expect(() => zcashV5PrevTxToLedgerWire(wire.subarray(0, wire.length - 8))).toThrow(/truncated/);
  });
});

// ---------------------------------------------------------------------------
// consensus branch id gate
// ---------------------------------------------------------------------------

describe('consensus branch id capability gate', () => {
  it('maps heights the way the signer kit does', () => {
    expect(branchForHeight(NETWORK_UPGRADE_ACTIVATION['nu6.3'])).toBe('nu6.3');
    expect(branchForHeight(NETWORK_UPGRADE_ACTIVATION['nu6.3'] - 1)).toBe('nu6.2');
    expect(branchForHeight(NETWORK_UPGRADE_ACTIVATION.nu5)).toBe('nu5');
    expect(branchForHeight(1)).toBe('overwinter');
    // getZcashBranchId(null) picks the newest upgrade, so an unknown height must
    // not be treated as "probably fine".
    expect(branchForHeight(undefined)).toBe('nu6.3');
  });

  it('blocks transparent signing at NU6.3 on every released app', () => {
    const support = transparentSigningSupport('3.6.0', NETWORK_UPGRADE_ACTIVATION['nu6.3']);
    expect(support.supported).toBe(false);
    expect(support.branchId).toBe(0x37a5165b);
    expect(support.blockers.some(b => /6a80/.test(b))).toBe(true);
    expect(ledgerCapabilities('3.6.0', NETWORK_UPGRADE_ACTIVATION['nu6.3']).transparent).toBe(false);
    // and with no height at all, for the same reason
    expect(ledgerCapabilities('3.6.0').transparent).toBe(false);
  });

  it('drops the branch-id blocker at NU6.2 and below, keeping only the SDK one', () => {
    // Below NU6.3 the app knows the branch id, so the only thing left standing
    // between us and a signature is the signer kit's SIGN apdu shape.
    const support = transparentSigningSupport('3.6.0', NETWORK_UPGRADE_ACTIVATION['nu6.2']);
    expect(support.branchId).toBe(0x5437f330);
    expect(support.blockers.some(b => /6a80/.test(b))).toBe(false);
    expect(support.blockers).toHaveLength(SIGNER_KIT_SIGN_APDU_COMPATIBLE ? 0 : 1);
    expect(support.supported).toBe(SIGNER_KIT_SIGN_APDU_COMPATIBLE);
  });

  it('never reports transparent as usable while the SDK apdu shape is wrong', () => {
    // The honest bottom line: no height, and no released app, makes this work.
    for (const height of [undefined, 1, NETWORK_UPGRADE_ACTIVATION.nu5, 9_999_999]) {
      expect(ledgerCapabilities('3.6.0', height).transparent).toBe(SIGNER_KIT_SIGN_APDU_COMPATIBLE);
    }
  });

  it('keeps the shielded gate independent of the height', () => {
    expect(ledgerCapabilities('3.6.0', NETWORK_UPGRADE_ACTIVATION.nu5).shielded).toBe(false);
    expect(ledgerCapabilities('3.8.0', NETWORK_UPGRADE_ACTIVATION.nu5).shielded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEVICE ROUND-TRIP
// ---------------------------------------------------------------------------

const device = await probeSpeculos();
const PATH = "44'/133'/0'/0/0";
const SW_OK = 0x9000;
const SW_INCORRECT_DATA = 0x6a80;
const SW_WRONG_LENGTH = 0x6700;

function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

function compressPubkey(uncompressed: Uint8Array): Uint8Array {
  const prefix = uncompressed[64]! % 2 === 0 ? 2 : 3;
  return Uint8Array.of(prefix, ...uncompressed.subarray(1, 33));
}

/** Read the device's transparent pubkey and derive the P2PKH it pays to. */
async function deviceScriptPubKey(dev: SpeculosDevice): Promise<string> {
  const out = await dev.sendOk(
    INS.GET_WALLET_PUBLIC_KEY,
    0x00,
    0x00,
    encodeBip32Path(PATH),
    'getPubKey',
  );
  const pubkey = out.subarray(1, 1 + out[0]!);
  return `76a914${bytesToHex(hash160(compressPubkey(pubkey)))}88ac`;
}

describe.skipIf(!device)('ledger transparent device round-trip (Speculos)', () => {
  const dev = device!;
  const PREV_VALUE = 200000;
  const SEND_VALUE = 150000;

  it('reports an app version our capability gate understands', async () => {
    const raw = await dev.sendOk(INS.GET_FIRMWARE_VERSION, 0, 0, undefined, 'getVersion');
    const version = parseAppVersion(raw);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    const caps = ledgerCapabilities(version, NETWORK_UPGRADE_ACTIVATION['nu6.2']);
    expect(caps.appVersion).toBe(version);
    // shielded needs >= 3.8.0, which is unreleased; the highest public tag is 3.6.0
    expect(caps.shielded).toBe(false);
    // ...and transparent is blocked too, by the SDK's SIGN apdu shape - the last
    // test in this file makes the device say so itself.
    expect(caps.transparent).toBe(false);
    expect(caps.transparentReason).toMatch(/6700/);
  });

  it('rejects Zcash consensus wire bytes and accepts our re-framing', async () => {
    // THE proof that serializedPreviousTransactionOverride needed changing.
    const consensus = consensusV5();
    const { serialized } = zcashV5PrevTxToLedgerWire(consensus);
    const vout = Uint8Array.of(0, 0, 0, 0); // index lookup, big-endian

    const bad = await sendChunked(
      dev,
      INS.GET_TRUSTED_INPUT,
      Uint8Array.of(...vout, ...consensus),
      'trustedInput(consensus)',
    );
    expect(bad.sw).toBe(SW_INCORRECT_DATA);

    const good = await sendChunked(
      dev,
      INS.GET_TRUSTED_INPUT,
      Uint8Array.of(...vout, ...serialized),
      'trustedInput(ledger framing)',
    );
    expect(good.sw).toBe(SW_OK);
    // trusted input blob: 0x32 magic || 0x00 || 2 random || txid(32) ||
    // index(4) || amount(8) || hmac(8)
    expect(good.data[0]).toBe(0x32);
    expect(good.data).toHaveLength(56);
  });

  it('rejects a NU6.3 branch id, exactly as the capability gate predicts', async () => {
    const nu63 = consensusV5({ branchId: CONSENSUS_BRANCH_ID['nu6.3'] });
    const { serialized } = zcashV5PrevTxToLedgerWire(nu63);
    const res = await sendChunked(
      dev,
      INS.GET_TRUSTED_INPUT,
      Uint8Array.of(0, 0, 0, 0, ...serialized),
      'trustedInput(nu6.3)',
    );
    expect(res.sw).toBe(SW_INCORRECT_DATA);

    const raw = await dev.sendOk(INS.GET_FIRMWARE_VERSION, 0, 0, undefined, 'getVersion');
    expect(transparentSigningSupport(parseAppVersion(raw), undefined).supported).toBe(false);
  });

  /**
   * Full legacy flow: trusted input -> hash the tx -> review+approve -> sign.
   * `outputScriptHex` is fed to the device exactly as `buildOutputScriptHex`
   * produced it, so a signature means the device parsed OUR bytes.
   */
  async function signOnDevice(
    expiry: Uint8Array,
    lockTime = 0,
    sendValue = SEND_VALUE,
  ): Promise<{ signature: string; screens: string[] }> {
    const script = await deviceScriptPubKey(dev);
    const prev = zcashV5PrevTxToLedgerWire(
      consensusV5({ outputs: [{ value: PREV_VALUE, script }] }),
    );

    const ti = await sendChunked(
      dev,
      INS.GET_TRUSTED_INPUT,
      Uint8Array.of(0, 0, 0, 0, ...prev.serialized),
      'trustedInput',
    );
    expect(ti.sw).toBe(SW_OK);

    // header: version | versionGroupId | branchId | varint(inputs)
    const header = Uint8Array.of(...prev.serialized.subarray(0, 12), 0x01);
    const scriptBytes = hexToBytes(script);
    const sequence = Uint8Array.of(0xff, 0xff, 0xff, 0xff);

    const feedInputs = async (p1: number, p2: number) => {
      await dev.sendOk(INS.HASH_INPUT_START, p1, p2, header, 'hashInputStart');
      await dev.sendOk(
        INS.HASH_INPUT_START,
        0x80,
        0x80,
        Uint8Array.of(0x01, ti.data.length, ...ti.data, ...compactSize(scriptBytes.length)),
        'hashInput(trusted input)',
      );
      await dev.sendOk(
        INS.HASH_INPUT_START,
        0x80,
        0x80,
        Uint8Array.of(...scriptBytes, ...sequence),
        'hashInput(script)',
      );
    };

    // first pass: hash the tx, then hand the device OUR output blob and let the
    // user (us) approve what it renders
    await feedInputs(0x00, 0x05);
    const outputBlob = hexToBytes(
      buildOutputScriptHex([{ scriptPubKeyHex: script, valueZat: sendValue }]),
    );
    const { result, screens } = await dev.approving(() =>
      dev.send(INS.HASH_INPUT_FINALIZE_FULL, 0x80, 0x00, outputBlob),
    );
    expect(result.sw).toBe(SW_OK);

    // second pass: replay for signing, then the extra header (lockTime,
    // sigHashType, expiry) and the signing path
    await feedInputs(0x00, 0x80);
    await dev.sendOk(
      INS.HASH_SIGN,
      0x00,
      0x00,
      Uint8Array.of(
        0x00,
        0x00,
        (lockTime >>> 24) & 0xff,
        (lockTime >>> 16) & 0xff,
        (lockTime >>> 8) & 0xff,
        lockTime & 0xff,
        0x01,
        ...expiry,
      ),
      'hashSign(extra header)',
    );
    const sig = await dev.sendOk(INS.HASH_SIGN, 0x00, 0x00, encodeBip32Path(PATH), 'hashSign');

    // the app parks on a "Transaction signed" status screen and stops answering
    // APDUs until it is dismissed - the next flow would block on its first command
    await dev.settle();
    return { signature: bytesToHex(sig), screens };
  }

  it('signs a transaction built from buildOutputScriptHex, and shows the right amounts', async () => {
    const { signature, screens } = await signOnDevice(expiryHeightBytes(100000));

    // the device decoded OUR output blob: the amount, and fee = in - out
    const shown = screens.join(' | ');
    expect(shown).toMatch(/0\.00150000 ZEC/);
    expect(shown).toMatch(/0\.00050000 ZEC/);

    // a real DER-encoded secp256k1 signature with the sighash byte appended
    expect(signature.startsWith('30')).toBe(true);
    expect(signature.endsWith('01')).toBe(true);
    expect(signature.length).toBeGreaterThan(130);
  }, 60_000);

  it('does not commit to the expiry height or lockTime on the SIGN apdu', async () => {
    // Went looking for a big-endian/little-endian differential and found
    // something worse: neither field reaches the sighash at all. app-zcash
    // computes the signature digest at the end of the input replay
    // (`parse_input_script` -> compute_transparent_input_signature_digest),
    // which is BEFORE `handler_hash_sign` is handed lockTime/sigHashType/expiry,
    // so the header digest always commits to expiry 0 and lockTime 0.
    const be = await signOnDevice(expiryHeightBytes(100000));
    const le = await signOnDevice(expiryHeightBytes(100000).reverse());
    const otherLockTime = await signOnDevice(expiryHeightBytes(100000), 0x11223344);

    expect(le.signature).toBe(be.signature);
    expect(otherLockTime.signature).toBe(be.signature);
    expect(APP_COMMITS_TO_EXPIRY_HEIGHT).toBe(false);

    // ...and the digest really is live, so the equality above is a finding and
    // not a broken harness: changing an output value DOES change the signature.
    const cheaper = await signOnDevice(expiryHeightBytes(100000), 0, SEND_VALUE - 1);
    expect(cheaper.signature).not.toBe(be.signature);
  }, 180_000);

  it('rejects the SIGN apdu shape signer-kit 0.5.0 actually sends', async () => {
    // The blocker we cannot fix from here: SignTransactionCommand builds ONE
    // 0x48 frame of path || 0x00 || lockTime(4) || sigHashType(1) || expiry(4).
    // The app wants an 11-byte extra-header frame with an EMPTY path first.
    const script = await deviceScriptPubKey(dev);
    const prev = zcashV5PrevTxToLedgerWire(
      consensusV5({ outputs: [{ value: PREV_VALUE, script }] }),
    );
    const ti = await sendChunked(
      dev,
      INS.GET_TRUSTED_INPUT,
      Uint8Array.of(0, 0, 0, 0, ...prev.serialized),
      'trustedInput',
    );
    const header = Uint8Array.of(...prev.serialized.subarray(0, 12), 0x01);
    const scriptBytes = hexToBytes(script);
    await dev.sendOk(INS.HASH_INPUT_START, 0x00, 0x05, header, 'hashInputStart');
    await dev.sendOk(
      INS.HASH_INPUT_START,
      0x80,
      0x80,
      Uint8Array.of(0x01, ti.data.length, ...ti.data, ...compactSize(scriptBytes.length)),
      'hashInput(trusted input)',
    );
    await dev.sendOk(
      INS.HASH_INPUT_START,
      0x80,
      0x80,
      Uint8Array.of(...scriptBytes, 0xff, 0xff, 0xff, 0xff),
      'hashInput(script)',
    );
    const outputBlob = hexToBytes(
      buildOutputScriptHex([{ scriptPubKeyHex: script, valueZat: SEND_VALUE }]),
    );
    const { result } = await dev.approving(() =>
      dev.send(INS.HASH_INPUT_FINALIZE_FULL, 0x80, 0x00, outputBlob),
    );
    expect(result.sw).toBe(SW_OK);

    // exactly what signer-kit 0.5.0 puts on the wire as its FIRST 0x48
    const combined = Uint8Array.of(
      ...encodeBip32Path(PATH),
      0x00,
      0,
      0,
      0,
      0,
      0x01,
      ...expiryHeightBytes(100000),
    );
    const res = await dev.send(INS.HASH_SIGN, 0x00, 0x00, combined);
    expect(res.sw).toBe(SW_WRONG_LENGTH);
    expect(SIGNER_KIT_SIGN_APDU_COMPATIBLE).toBe(false);
  }, 120_000);
});
