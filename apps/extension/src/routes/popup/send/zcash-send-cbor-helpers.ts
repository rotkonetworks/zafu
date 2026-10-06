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
 * Facts the Zigner KERNEL (not the wasm module) reports about itself in a
 * signing response. A module cannot attest its own version - that is exactly
 * what a malicious module would lie about - so these come from the APK.
 *
 * Mirrors Keystone's firmware version in its sign result: it lets the wallet
 * say "update Zigner" up front instead of failing after the user approved.
 */
export interface SignerKernelInfo {
  /** Version of the module baked into the APK (BAKED_MODULE_VERSION). */
  bakedModuleVersion?: number;
  /** Version of the module that actually produced this response. */
  activeModuleVersion?: number;
  /** Kernel <-> module host ABI version. */
  hostAbiVersion?: number;
}

const KERNEL_INFO_KEYS: Record<number, keyof SignerKernelInfo> = {
  1: 'bakedModuleVersion',
  2: 'activeModuleVersion',
  3: 'hostAbiVersion',
};

/**
 * Strip the CBOR envelope around a signer response: `{1: bytes}` or, from
 * newer Zigner builds, `{1: bytes, 2: {uint: uint, ...}}` where key 2 is the
 * kernel's [`SignerKernelInfo`].
 *
 * Parsed positionally and strictly - no generic CBOR decoder: canonical key
 * order, every length checked before use, the buffer consumed exactly, key 2
 * limited to small unsigned-integer pairs with no duplicate keys. Unknown
 * key-2 entries are skipped (forward compatible) but must still be uints.
 */
export function unwrapSignerEnvelope(cbor: Uint8Array): {
  payload: Uint8Array;
  kernel: SignerKernelInfo | null;
} {
  if (cbor.length < 3) {
    throw new Error('CBOR PCZT envelope too short');
  }
  const entries = cbor[0];
  if (entries !== 0xa1 && entries !== 0xa2) {
    throw new Error('expected CBOR map(1) or map(2) at offset 0');
  }
  if (cbor[1] !== 0x01) {
    throw new Error('expected CBOR key 1 at offset 1');
  }
  let pos = 2;

  // Read a big-endian length of `nBytes`, checking every byte is present
  // before reading it. Accumulate with `* 256 + b` rather than `<< 8`:
  // JS bitwise ops are signed 32-bit, so a 0x5a length with the high bit
  // set (>= 2 GiB) would go negative, slip past the `len > remaining`
  // guard, and yield a silently-truncated PCZT. Multiplication keeps it a
  // positive JS number.
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

  const tag = cbor[pos++]!;
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
  if (pos + len > cbor.length) {
    throw new Error(
      `CBOR PCZT envelope truncated: declared length ${len} at offset ${pos} ` +
        `vs buffer length ${cbor.length}`,
    );
  }
  const payload = cbor.slice(pos, pos + len);
  pos += len;

  if (entries === 0xa1) {
    // Canonical single-PCZT envelope: the byte string must consume the buffer
    // exactly. Trailing bytes mean a malformed or smuggled payload.
    if (pos !== cbor.length) {
      throw new Error(`CBOR PCZT envelope not canonical: ${cbor.length - pos} trailing bytes`);
    }
    return { payload, kernel: null };
  }

  // map(2): key 2 = kernel info, a map of uint -> uint.
  if (cbor[pos++] !== 0x02) {
    throw new Error('expected CBOR key 2 after the payload');
  }
  const readUint = (what: string): number => {
    if (pos >= cbor.length) {
      throw new Error(`CBOR ${what} truncated`);
    }
    const b = cbor[pos++]!;
    if (b <= 0x17) {
      return b;
    }
    if (b === 0x18) {
      return readLen(1);
    }
    if (b === 0x19) {
      return readLen(2);
    }
    if (b === 0x1a) {
      return readLen(4);
    }
    throw new Error(`expected CBOR unsigned int for ${what}, got 0x${b.toString(16)}`);
  };
  const head = cbor[pos++];
  if (head === undefined || head < 0xa0 || head > 0xb7) {
    throw new Error('expected a small CBOR map for kernel info');
  }
  const kernel: SignerKernelInfo = {};
  const seen = new Set<number>();
  for (let i = 0; i < head - 0xa0; i++) {
    const k = readUint('kernel info key');
    const v = readUint('kernel info value');
    if (seen.has(k)) {
      throw new Error(`duplicate kernel info key ${k}`);
    }
    seen.add(k);
    const field = KERNEL_INFO_KEYS[k];
    if (field) {
      kernel[field] = v;
    }
  }
  if (pos !== cbor.length) {
    throw new Error(`CBOR signer envelope not canonical: ${cbor.length - pos} trailing bytes`);
  }
  return { payload, kernel };
}

/**
 * Strip the CBOR envelope wrapping a `zcash-pczt` / `zigner-module` UR
 * payload and return only the payload. Inverse of the wasm-side
 * `cborWrapPczt`. Accepts the optional kernel-info entry newer Zigner builds
 * add (see [`unwrapSignerEnvelope`]); use that function to read it.
 */
export function unwrapCborSinglePczt(cbor: Uint8Array): Uint8Array {
  return unwrapSignerEnvelope(cbor).payload;
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

/**
 * Compact single-PCZT request prelude: [0x53][zcash 0x04][tx_type 0x05].
 *
 * Same body as 0x03 - the difference is that the PCZT has been compact-redacted
 * (see `redact_pczt_compact`) and that the device answers with a
 * signatures-only response (0x07) instead of a whole signed PCZT.
 */
export const ZIGNER_PRELUDE_PCZT_SINGLE_COMPACT = Object.freeze([0x53, 0x04, 0x05] as const);

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
export function preludeWrapSinglePczt(pczt: Uint8Array, compact = false): Uint8Array {
  const prelude = compact ? ZIGNER_PRELUDE_PCZT_SINGLE_COMPACT : ZIGNER_PRELUDE_PCZT_SINGLE;
  const out = new Uint8Array(prelude.length + pczt.length);
  out.set(prelude, 0);
  out.set(pczt, prelude.length);
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
