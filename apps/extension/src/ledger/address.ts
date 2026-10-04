/**
 * Transparent-address -> output scriptPubKey, for the Ledger legacy transparent
 * send path.
 *
 * The Ledger legacy signer takes recipient/change outputs as raw
 * `scriptPubKey` bytes (see `buildOutputScriptHex` in ./transparent.ts), so the
 * send-plan has to turn a user-facing Zcash t-address into the exact script the
 * output pays to. Getting this wrong sends money to a script nobody can spend,
 * so we base58check-DECODE with a real checksum verification (double-SHA256)
 * rather than the checksum-skipping strip the worker's history parser does - a
 * mistyped address must fail here, loudly, before it reaches the device.
 *
 * Self-contained (crypto.subtle only) so the ledger module keeps its "no
 * coupling to the rest of the extension" property. Runs in the page context
 * where WebHID (and therefore this whole flow) lives; crypto.subtle is present
 * there.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Zcash transparent address version prefixes (2 bytes, big-endian on the wire).
 * P2PKH pays to `OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG`;
 * P2SH pays to `OP_HASH160 <20> OP_EQUAL`.
 */
const ADDRESS_VERSIONS = {
  mainnet: { p2pkh: [0x1c, 0xb8], p2sh: [0x1c, 0xbd] },
  testnet: { p2pkh: [0x1d, 0x25], p2sh: [0x1c, 0xba] },
} as const;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return new Uint8Array(digest);
}

function decodeBase58(addr: string): Uint8Array {
  let num = 0n;
  for (const c of addr) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx < 0) {
      throw new Error(`ledger address: '${c}' is not a base58 character`);
    }
    num = num * 58n + BigInt(idx);
  }
  // Zcash t-addresses are 2-byte version + 20-byte hash + 4-byte checksum = 26
  // bytes. Leading '1' characters encode leading zero bytes; t-addresses never
  // begin with a zero version byte, so a fixed 26-byte field is exact.
  const out = new Uint8Array(26);
  for (let i = 25; i >= 0; i--) {
    out[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  if (num !== 0n) {
    throw new Error('ledger address: decoded payload is longer than 26 bytes');
  }
  return out;
}

function encodeBase58(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) {
    num = (num << 8n) | BigInt(b);
  }
  let out = '';
  while (num > 0n) {
    out = BASE58_ALPHABET[Number(num % 58n)]! + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) {
      break;
    }
    out = '1' + out;
  }
  return out;
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) {
        chk ^= gen[i]!;
      }
    }
  }
  return chk >>> 0;
}

/**
 * A ZIP 320 TEX address (`tex1...` / `textest1...`): bech32m over the 20-byte
 * hash of a P2PKH key. On chain it is exactly that P2PKH output; the address
 * only adds the rule that the paying transaction spends transparent inputs
 * alone (so the receiver can refund to them). Throws on anything else.
 */
export function decodeTexAddress(addr: string, mainnet: boolean): Uint8Array {
  const lower = addr.toLowerCase();
  const hrp = mainnet ? 'tex' : 'textest';
  if (addr !== lower && addr !== addr.toUpperCase()) {
    throw new Error(`ledger address: ${addr} mixes upper and lower case`);
  }
  if (!lower.startsWith(`${hrp}1`) || lower.lastIndexOf('1') !== hrp.length) {
    throw new Error(
      `ledger address: ${addr} is not a ${mainnet ? 'mainnet' : 'testnet'} tex address`,
    );
  }
  const data = [...lower.slice(hrp.length + 1)].map(c => BECH32_CHARSET.indexOf(c));
  if (data.length < 7 || data.some(v => v < 0)) {
    throw new Error(`ledger address: ${addr} is not bech32m`);
  }
  const expanded = [
    ...[...hrp].map(c => c.charCodeAt(0) >> 5),
    0,
    ...[...hrp].map(c => c.charCodeAt(0) & 31),
  ];
  if (bech32Polymod([...expanded, ...data]) !== BECH32M_CONST) {
    throw new Error(`ledger address: bad checksum for ${addr}`);
  }
  // 5-bit groups -> bytes, no padding allowed past the last whole byte
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0 || out.length !== 20) {
    throw new Error(`ledger address: ${addr} does not carry a 20-byte key hash`);
  }
  return Uint8Array.from(out);
}

/** a tex address? (the shape only; decodeTexAddress checks it) */
export const isTexAddress = (addr: string): boolean => /^tex(test)?1/i.test(addr);

function eq(a: Uint8Array, b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

export interface DecodedTransparentAddress {
  readonly kind: 'p2pkh' | 'p2sh';
  /** the 20-byte pubkey-hash (p2pkh) or script-hash (p2sh). */
  readonly hash: Uint8Array;
}

/**
 * Base58check-decode a Zcash t-address, VERIFYING the checksum, and classify it
 * as P2PKH or P2SH for the requested network. Throws on any mismatch.
 */
export async function decodeTransparentAddress(
  addr: string,
  mainnet: boolean,
): Promise<DecodedTransparentAddress> {
  // ZIP 320: a tex address is the P2PKH of its key hash, paid from transparent inputs only
  if (isTexAddress(addr)) {
    return { kind: 'p2pkh', hash: decodeTexAddress(addr, mainnet) };
  }
  const raw = decodeBase58(addr);
  const version = raw.subarray(0, 2);
  const hash = raw.subarray(2, 22);
  const checksum = raw.subarray(22, 26);

  const expected = (await sha256(await sha256(raw.subarray(0, 22)))).subarray(0, 4);
  if (!eq(checksum, [...expected])) {
    throw new Error(`ledger address: bad checksum for ${addr}`);
  }

  const v = ADDRESS_VERSIONS[mainnet ? 'mainnet' : 'testnet'];
  if (eq(version, v.p2pkh)) {
    return { kind: 'p2pkh', hash: Uint8Array.from(hash) };
  }
  if (eq(version, v.p2sh)) {
    return { kind: 'p2sh', hash: Uint8Array.from(hash) };
  }
  throw new Error(
    `ledger address: ${addr} is not a ${mainnet ? 'mainnet' : 'testnet'} transparent address ` +
      `(version 0x${toHex(version)})`,
  );
}

/**
 * The output `scriptPubKey` hex a transparent send to `addr` must pay to.
 * P2PKH -> `76a914 <hash> 88ac`; P2SH -> `a914 <hash> 87`.
 */
export async function transparentAddressToScriptHex(
  addr: string,
  mainnet: boolean,
): Promise<string> {
  const { kind, hash } = await decodeTransparentAddress(addr, mainnet);
  const h = toHex(hash);
  return kind === 'p2pkh' ? `76a914${h}88ac` : `a914${h}87`;
}

/**
 * The base58 t-address that pays the same script as `addr`. For a tex address
 * that is its P2PKH twin: builders that know only base58 pay it, and the
 * output bytes are identical. Only for a transaction with transparent inputs
 * alone (ZIP 320); any other address comes back unchanged once it decodes.
 */
export async function payableTransparentAddress(addr: string, mainnet: boolean): Promise<string> {
  const { kind, hash } = await decodeTransparentAddress(addr, mainnet);
  if (!isTexAddress(addr)) {
    return addr;
  }
  const v = ADDRESS_VERSIONS[mainnet ? 'mainnet' : 'testnet'];
  const body = Uint8Array.from([...(kind === 'p2pkh' ? v.p2pkh : v.p2sh), ...hash]);
  const check = (await sha256(await sha256(body))).subarray(0, 4);
  return encodeBase58(Uint8Array.from([...body, ...check]));
}
