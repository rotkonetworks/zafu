/**
 * ZIP-316 unified address encoding for Zcash Orchard
 *
 * Converts raw orchard receiver bytes into proper bech32m-encoded
 * unified addresses (u1...). Used to fix the debug-format output
 * from zafu-wasm's get_receiving_address_at().
 *
 * References:
 * - ZIP-316: https://zips.z.cash/zip-0316
 * - F4Jumble: https://zips.z.cash/zip-0316#jumbling
 * - bech32m: BIP-350
 */

import { blake2b } from '@noble/hashes/blake2b';

// ── bech32m encoding (BIP-350) ──

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function bech32mPolymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >>> i) & 1) chk ^= GEN[i]!;
    }
  }
  return chk;
}

function bech32mHrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >>> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32mCreateChecksum(hrp: string, data: number[]): number[] {
  const values = bech32mHrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32mPolymod(values) ^ BECH32M_CONST;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) ret.push((polymod >>> (5 * (5 - i))) & 31);
  return ret;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << toBits) - 1;
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    acc = (acc << fromBits) | data[i]!;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
  }
  return result;
}

function bech32mEncode(hrp: string, data: Uint8Array, limit = 1023): string {
  const words = convertBits(data, 8, 5, true);
  const checksum = bech32mCreateChecksum(hrp, words);
  let result = hrp + '1';
  for (const w of words.concat(checksum)) result += CHARSET[w]!;
  if (result.length > limit) throw new Error(`bech32m result exceeds limit: ${result.length} > ${limit}`);
  return result;
}

// ── F4Jumble (ZIP-316) ──

const PERS_H = (i: number, l: number): Uint8Array => {
  const p = new Uint8Array(16);
  const dv = new DataView(p.buffer);
  // "UA_F4Jumble_H" + i (1 byte) + length (2 bytes LE)
  const tag = 'UA_F4Jumble_H';
  for (let j = 0; j < tag.length; j++) p[j] = tag.charCodeAt(j);
  p[13] = i;
  dv.setUint16(14, l, true);
  return p;
};

const PERS_G = (i: number, l: number): Uint8Array => {
  const p = new Uint8Array(16);
  const dv = new DataView(p.buffer);
  const tag = 'UA_F4Jumble_G';
  for (let j = 0; j < tag.length; j++) p[j] = tag.charCodeAt(j);
  p[13] = i;
  dv.setUint16(14, l, true);
  return p;
};

/** BLAKE2b-based PRF: hash `input` with personalization, producing `outputLen` bytes */
function hashBlake2b(personalization: Uint8Array, input: Uint8Array, outputLen: number): Uint8Array {
  if (outputLen <= 64) {
    return blake2b(input, { dkLen: outputLen, personalization });
  }
  // long output: concatenate ceil(outputLen/32) hashes of 64 bytes each,
  // with incrementing counter in personalization
  const result = new Uint8Array(outputLen);
  let offset = 0;
  let counter = 0;
  while (offset < outputLen) {
    // personalization with counter appended
    const pers = new Uint8Array(personalization);
    // the counter is embedded in the personalization byte at position 13
    // Actually per ZIP-316, for long outputs: produce ceil(n/B2_HASH_LEN) blocks
    // We hash (counter || input) with the personalization
    const counterBuf = new Uint8Array(4);
    new DataView(counterBuf.buffer).setUint32(0, counter, true);
    const msg = new Uint8Array(4 + input.length);
    msg.set(counterBuf, 0);
    msg.set(input, 4);
    const chunk = blake2b(msg, { dkLen: 64, personalization: pers });
    const take = Math.min(64, outputLen - offset);
    result.set(chunk.subarray(0, take), offset);
    offset += take;
    counter++;
  }
  return result;
}

/**
 * F4Jumble forward transform per ZIP-316.
 * Two-round unbalanced Feistel cipher.
 */
export function f4Jumble(M: Uint8Array): Uint8Array {
  const l = M.length;
  if (l < 48 || l > 4194368) throw new Error(`f4Jumble: invalid length ${l}`);

  const lL = Math.min(Math.floor(l / 2), 64);
  const lR = l - lL;

  // split into left (a) and right (b)
  let a: Uint8Array = Uint8Array.from(M.slice(0, lL));
  let b: Uint8Array = Uint8Array.from(M.slice(lL));

  // round 1: b = b XOR G(a)
  b = xor(b, Uint8Array.from(hashBlake2b(PERS_G(0, lL), a, lR)));

  // round 2: a = a XOR H(b)
  a = xor(a, Uint8Array.from(hashBlake2b(PERS_H(0, lR), b, lL)));

  // round 3: b = b XOR G(a)
  b = xor(b, Uint8Array.from(hashBlake2b(PERS_G(1, lL), a, lR)));

  // round 4: a = a XOR H(b)
  a = xor(a, Uint8Array.from(hashBlake2b(PERS_H(1, lR), b, lL)));

  const result = new Uint8Array(l);
  result.set(a, 0);
  result.set(b, lL);
  return result;
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) result[i] = a[i]! ^ b[i]!;
  return result;
}

// ── unified address encoding ──

/**
 * Encode raw orchard receiver bytes as a ZIP-316 unified address.
 *
 * Layout: [typecode=0x03][length=43][43 raw bytes] + 16 zero padding bytes
 * Then F4Jumble, then bech32m with HRP "u" (mainnet) or "utest" (testnet).
 */
export function encodeOrchardUnifiedAddress(rawBytes: Uint8Array, mainnet = true): string {
  if (rawBytes.length !== 43) {
    throw new Error(`orchard receiver must be 43 bytes, got ${rawBytes.length}`);
  }

  // unified address container: typecode (CompactSize) + length (CompactSize) + data + 16-byte padding
  // orchard typecode = 0x03, length = 0x2b (43)
  const container = new Uint8Array(1 + 1 + 43 + 16);
  container[0] = 0x03; // typecode: orchard
  container[1] = 43; // length
  container.set(rawBytes, 2);
  // last 16 bytes are zero padding (already zeroed)

  const jumbled = f4Jumble(container);
  const hrp = mainnet ? 'u' : 'utest';
  return bech32mEncode(hrp, jumbled);
}

/**
 * Fix an address that comes back as "u1orchard:{hex}" from the WASM debug format.
 * Converts to proper bech32m unified address.
 * If the address doesn't match the debug format, returns it unchanged.
 */
export function fixOrchardAddress(addr: string, mainnet = true): string {
  const orchardPrefix = mainnet ? 'u1orchard:' : 'utest1orchard:';
  if (!addr.startsWith(orchardPrefix)) return addr;

  const hex = addr.slice(orchardPrefix.length);
  if (hex.length !== 86) return addr; // 43 bytes = 86 hex chars

  const rawBytes = new Uint8Array(43);
  for (let i = 0; i < 43; i++) {
    rawBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return encodeOrchardUnifiedAddress(rawBytes, mainnet);
}
