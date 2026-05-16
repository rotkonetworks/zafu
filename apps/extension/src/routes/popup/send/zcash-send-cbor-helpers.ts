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
  if (cbor.length < 3) throw new Error('CBOR PCZT envelope too short');
  if (cbor[0] !== 0xa1) throw new Error('expected CBOR map(1) at offset 0');
  if (cbor[1] !== 0x01) throw new Error('expected CBOR key 1 at offset 1');
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
    for (let i = 0; i < nBytes; i++) v = v * 256 + cbor[pos++]!;
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
