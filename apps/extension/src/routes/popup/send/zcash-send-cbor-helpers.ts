/**
 * Pure-byte helpers for the `zcash-pczt` UR transport envelope.
 *
 * Kept in their own module so they can be imported by the send route AND
 * by unit tests without dragging in extension state, IndexedDB, or any other
 * environment-coupled code. The wasm-side encoder lives in
 * `apps/extension/src/workers/zcash-worker.ts` (`cborWrapPczt`); this file
 * is the inverse on the receive side.
 */

/**
 * Strip the CBOR `{1: bytes}` envelope wrapping a `zcash-pczt` UR payload.
 * Inverse of the wasm-side `cborWrapPczt`. Mirrors what zigner's signer does
 * internally — the envelope is a fixed shape so we can parse positionally
 * without pulling in a generic CBOR decoder.
 */
export function unwrapCborSinglePczt(cbor: Uint8Array): Uint8Array {
  if (cbor.length < 3) {
    throw new Error('CBOR PCZT envelope too short');
  }
  if (cbor[0] !== 0xa1) {
    throw new Error('expected CBOR map(1) at offset 0');
  }
  if (cbor[1] !== 0x01) {
    throw new Error('expected CBOR key 1 at offset 1');
  }
  let pos = 2;
  const tag = cbor[pos++]!;

  // Read a big-endian length of `nBytes`, checking every byte is present
  // before reading it. Accumulate with `* 256 + b` rather than `<< 8`:
  // JS bitwise ops are signed 32-bit, so a 0x5a length with the high bit
  // set (>= 2 GiB) would go negative, slip past the `len > remaining`
  // guard, and yield a silently-truncated PCZT. Multiplication keeps it a
  // positive JS number. A length that large is bogus for a PCZT anyway —
  // the size sanity check below rejects it — but we must not let it become
  // negative first.
  const readLen = (nBytes: number): number => {
    if (pos + nBytes > cbor.length) {
      throw new Error(`CBOR length header truncated (need ${nBytes} bytes)`);
    }
    let v = 0;
    for (let i = 0; i < nBytes; i++) {
      v = v * 256 + cbor[pos++]!;
    }
    return v;
  };

  let len: number;
  if (tag >= 0x40 && tag <= 0x57) {
    len = tag - 0x40; // length packed in the tag (0..23)
  } else if (tag === 0x58) {
    len = readLen(1);
  } else if (tag === 0x59) {
    len = readLen(2);
  } else if (tag === 0x5a) {
    len = readLen(4);
  } else {
    throw new Error(`unexpected CBOR bytes tag 0x${tag.toString(16)}`);
  }

  // Canonical single-PCZT envelope: the byte string must consume the buffer
  // exactly. Trailing bytes mean a malformed or smuggled payload — reject
  // rather than silently ignore them.
  if (pos + len !== cbor.length) {
    throw new Error(
      `CBOR PCZT envelope not canonical: declared length ${len} at offset ${pos} ` +
        `vs buffer length ${cbor.length} (expected exact consume)`,
    );
  }
  return cbor.slice(pos, pos + len);
}

// ===========================================================================
// Ironwood-aware signer prelude envelope (FIX-C item 1)
//
// The turnstile (orchard -> ironwood) migration MUST NOT travel over the
// `zcash-pczt` CBOR `{1: bytes}` envelope. That envelope is consumed by the
// production, ironwood-BLIND signer path (rust/signer's crates.io pczt) which
// cannot see V6 / ironwood outputs - it hides the migration destination and
// renders a fee ~= the whole migrated amount. Instead we ship the migration
// PCZT in the zigner prelude envelope `[0x53][crypto=0x04][tx_type=0x03]` that
// reaches the ironwood-AWARE `pczt_signing` module (built with
// --cfg zcash_unstable="nu6.3"). See zigner rust/pczt_signing/src/envelope.rs.
//
// Wire format (from envelope.rs, little-endian lengths):
//   single request:  [0x53][0x04][0x03] || pczt_bytes
//   single response: [0x53][0x04][0x03] || digest:32 || pczt_len:u32(LE) || signed_pczt
//
// Transport (RECONCILED with feat/ironwood-v6-signer): both request and
// response ride the BC-UR fountain under UR type `zigner-module`.
//   REQUEST  (wallet -> device): ur_encode_frames(preludeWrapSinglePczt(pczt),
//     'zigner-module') carries the RAW envelope [0x53][0x04][0x03]||pczt (NO
//     CBOR wrap). The device fountain-decodes it (signer `decode_ur_module_request`)
//     and dispatches on the 6-hex prelude via CameraViewModel's
//     `isZcashModulePcztRequest` - the same predicate as the raw-byte / substrate
//     multi-QR paths.
//   RESPONSE (device -> wallet): the device's `module_response_to_ur` wraps the
//     prelude response envelope in CBOR {1: bytes} before the fountain, so the
//     scanner yields the CBOR wrap - unwrap it (unwrapCborSinglePczt) THEN parse
//     the inner prelude (parsePreludeSinglePcztResponse).
// The envelope byte layout is frozen by the contract; only the UR type is shared.
// ===========================================================================

/** zigner envelope prelude bytes: [0x53][crypto=zcash 0x04][tx_type=PCZT single 0x03]. */
export const ZIGNER_PRELUDE_PCZT_SINGLE = Object.freeze([0x53, 0x04, 0x03] as const);

/** UR type carrying the prelude-envelope single-PCZT signing REQUEST (hot -> cold). */
export const ZIGNER_PCZT_SIGN_UR_TYPE = 'zigner-module';

/**
 * UR type carrying the module signed-PCZT RESPONSE (cold -> hot). The device
 * emits `ur:zigner-module` whose decoded payload is a CBOR `{1: bytes}` wrap of
 * the envelope response; unwrap the CBOR first, then hand the inner envelope
 * bytes to `parsePreludeSinglePcztResponse`. Do NOT feed this into the legacy
 * `parseZcashSignatureResponse` digest flow.
 */
export const ZIGNER_PCZT_SIGNED_UR_TYPE = 'zigner-module';

/**
 * Wrap a redacted migration PCZT in the ironwood-aware signer's single-PCZT
 * prelude envelope. Inverse of `parsePreludeSinglePcztResponse` (the response
 * carries an extra integrity digest + length prefix).
 */
export function preludeWrapSinglePczt(pczt: Uint8Array): Uint8Array {
  const out = new Uint8Array(ZIGNER_PRELUDE_PCZT_SINGLE.length + pczt.length);
  out.set(ZIGNER_PRELUDE_PCZT_SINGLE, 0);
  out.set(pczt, ZIGNER_PRELUDE_PCZT_SINGLE.length);
  return out;
}

/**
 * Parse a single-PCZT prelude-envelope RESPONSE from the ironwood-aware signer.
 * Layout: `[0x53][0x04][0x03] || digest:32 || pczt_len:u32(LE) || signed_pczt`.
 * Verifies the prelude, the sha256 integrity digest length prefix, and that the
 * declared length consumes the buffer exactly. Returns the raw signed PCZT
 * bytes (the caller hex-encodes + extracts). `expectedDigest`, when supplied,
 * lets the caller cross-check `sha256(signed_pczt)` (Keystone parity).
 */
export function parsePreludeSinglePcztResponse(payload: Uint8Array): {
  signedPczt: Uint8Array;
  digest: Uint8Array;
} {
  if (payload.length < 3) {
    throw new Error('prelude PCZT response too short');
  }
  if (payload[0] !== 0x53) {
    throw new Error(`expected prelude 0x53, got 0x${(payload[0] ?? 0).toString(16)}`);
  }
  if (payload[1] !== 0x04) {
    throw new Error(`expected crypto type zcash 0x04, got 0x${(payload[1] ?? 0).toString(16)}`);
  }
  if (payload[2] !== 0x03) {
    throw new Error(`expected single-PCZT tx type 0x03, got 0x${(payload[2] ?? 0).toString(16)}`);
  }
  // digest(32) + len(4) header must be present
  if (payload.length < 3 + 32 + 4) {
    throw new Error('prelude PCZT response truncated at digest/length header');
  }
  const digest = payload.slice(3, 3 + 32);
  let pos = 3 + 32;
  // little-endian u32 length. Accumulate with `+ b * 2**k` (not `<< 24`) so a
  // high-bit-set length stays a positive JS number rather than going signed.
  const len =
    payload[pos]! +
    payload[pos + 1]! * 256 +
    payload[pos + 2]! * 65536 +
    payload[pos + 3]! * 16777216;
  pos += 4;
  if (pos + len !== payload.length) {
    throw new Error(
      `prelude PCZT response not canonical: declared length ${len} at offset ${pos} ` +
        `vs buffer length ${payload.length} (expected exact consume)`,
    );
  }
  return { signedPczt: payload.slice(pos, pos + len), digest };
}
