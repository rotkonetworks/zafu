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
export async function transparentAddressToScriptHex(addr: string, mainnet: boolean): Promise<string> {
  const { kind, hash } = await decodeTransparentAddress(addr, mainnet);
  const h = toHex(hash);
  return kind === 'p2pkh' ? `76a914${h}88ac` : `a914${h}87`;
}
