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
// Reference: https://zips.z.cash/zip-0316#jumbling
// Matches librustzcash f4jumble implementation exactly.

const OUTBYTES = 64; // BLAKE2b max output

/**
 * H personalization: "UA_F4Jumble_H" (13 bytes) + round (1 byte) + 0x0000 (2 bytes)
 * Per spec: H_i has no chunk counter — bytes 14-15 are always zero.
 */
const hPers = (round: number): Uint8Array => {
  // [85,65,95,70,52,74,117,109,98,108,101,95,72, round, 0, 0]
  const p = new Uint8Array(16);
  const tag = 'UA_F4Jumble_H';
  for (let i = 0; i < tag.length; i++) p[i] = tag.charCodeAt(i);
  p[13] = round;
  // bytes 14-15 remain 0
  return p;
};

/**
 * G personalization: "UA_F4Jumble_G" (13 bytes) + round (1 byte) + chunk_j (2 bytes LE)
 * Per spec: G_i uses chunk counter j in bytes 14-15 for long-output PRF.
 */
const gPers = (round: number, chunkJ: number): Uint8Array => {
  // [85,65,95,70,52,74,117,109,98,108,101,95,71, round, j_lo, j_hi]
  const p = new Uint8Array(16);
  const tag = 'UA_F4Jumble_G';
  for (let i = 0; i < tag.length; i++) p[i] = tag.charCodeAt(i);
  p[13] = round;
  p[14] = chunkJ & 0xff;
  p[15] = (chunkJ >>> 8) & 0xff;
  return p;
};

/**
 * H round: BLAKE2b-lL(right, personalization=hPers(round))
 * H always produces <= 64 bytes (since lL <= 64), so single hash call.
 */
function hRound(round: number, input: Uint8Array, outputLen: number): Uint8Array {
  return blake2b(input, { dkLen: outputLen, personalization: hPers(round) });
}

/**
 * G round: long-output PRF using BLAKE2b-64 with chunk counter in personalization.
 * For outputLen <= 64: single BLAKE2b call with j=0.
 * For outputLen > 64: concatenate ceil(outputLen/64) BLAKE2b-64 blocks,
 * each with chunk counter j in bytes 14-15 of the personalization.
 */
function gRound(round: number, input: Uint8Array, outputLen: number): Uint8Array {
  // Always hash with dkLen=OUTBYTES (matches librustzcash: hash_length(OUTBYTES)).
  // BLAKE2b encodes dkLen in the parameter block, so dkLen=24 != truncate(dkLen=64, 24).
  const result = new Uint8Array(outputLen);
  let offset = 0;
  let j = 0;
  while (offset < outputLen) {
    const chunk = blake2b(input, { dkLen: OUTBYTES, personalization: gPers(round, j) });
    const take = Math.min(OUTBYTES, outputLen - offset);
    for (let k = 0; k < take; k++) result[offset + k] = chunk[k]!;
    offset += take;
    j++;
  }
  return result;
}

/** XOR b into a in-place */
function xorInPlace(a: Uint8Array, b: Uint8Array): void {
  for (let i = 0; i < a.length; i++) a[i]! ^= b[i]!;
}

/**
 * F4Jumble forward transform per ZIP-316.
 * 4-round unbalanced Feistel: G, H, G, H
 * Matches librustzcash: g_round(0), h_round(0), g_round(1), h_round(1)
 */
export function f4Jumble(M: Uint8Array): Uint8Array {
  const l = M.length;
  if (l < 48 || l > 4194368) throw new Error(`f4Jumble: invalid length ${l}`);

  const lL = Math.min(Math.floor(l / 2), OUTBYTES);
  const lR = l - lL;

  // split into left and right (mutable copies)
  const left = M.slice(0, lL);
  const right = M.slice(lL);

  // round 1: right ^= G_0(left)
  xorInPlace(right, gRound(0, left, lR));
  // round 2: left ^= H_0(right)
  xorInPlace(left, hRound(0, right, lL));
  // round 3: right ^= G_1(left)
  xorInPlace(right, gRound(1, left, lR));
  // round 4: left ^= H_1(right)
  xorInPlace(left, hRound(1, right, lL));

  const result = new Uint8Array(l);
  result.set(left, 0);
  result.set(right, lL);
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

  const hrp = mainnet ? 'u' : 'utest';

  // unified address container: typecode (CompactSize) + length (CompactSize) + data + 16-byte padding
  // orchard typecode = 0x03, length = 0x2b (43)
  // padding = HRP in US-ASCII, right-padded with 0x00 to 16 bytes (ZIP-316)
  const container = new Uint8Array(1 + 1 + 43 + 16);
  container[0] = 0x03; // typecode: orchard
  container[1] = 43; // length
  container.set(rawBytes, 2);
  // write HRP padding at offset 45 (= 1 + 1 + 43)
  const padOffset = 1 + 1 + rawBytes.length;
  for (let i = 0; i < hrp.length; i++) container[padOffset + i] = hrp.charCodeAt(i);

  const jumbled = f4Jumble(container);
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
