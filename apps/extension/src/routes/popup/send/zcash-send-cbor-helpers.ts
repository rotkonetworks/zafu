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
  let len: number;
  if (tag >= 0x40 && tag <= 0x57) {
    len = tag - 0x40;
  } else if (tag === 0x58) {
    len = cbor[pos++]!;
  } else if (tag === 0x59) {
    len = (cbor[pos]! << 8) | cbor[pos + 1]!;
    pos += 2;
  } else if (tag === 0x5a) {
    len = (cbor[pos]! << 24) | (cbor[pos + 1]! << 16) | (cbor[pos + 2]! << 8) | cbor[pos + 3]!;
    pos += 4;
  } else {
    throw new Error(`unexpected CBOR bytes tag 0x${tag.toString(16)}`);
  }
  if (pos + len > cbor.length) throw new Error('CBOR PCZT length exceeds envelope');
  return cbor.slice(pos, pos + len);
}
