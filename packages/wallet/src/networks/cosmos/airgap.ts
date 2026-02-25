/**
 * Cosmos Cold Wallet QR Code Integration
 *
 * Enables signing cosmos transactions with an air-gapped cold wallet (Zigner)
 * via QR codes.
 *
 * Sign request QR format (Zafu → Zigner):
 * [0x53][0x05][0x10]           - prelude (Substrate, Cosmos, Tx)
 * [account_index:4 LE]        - BIP44 account index
 * [chain_name_len:1]          - length of chain name
 * [chain_name:N]              - e.g. "noble", "osmosis"
 * [sign_doc_len:4 LE]         - length of sign doc bytes
 * [sign_doc_bytes:N]          - canonical amino JSON (UTF-8)
 *
 * Signature response QR format (Zigner → Zafu):
 * [signature:64]              - r||s compact secp256k1 ECDSA signature
 */

/** cosmos QR prelude bytes */
const PRELUDE = new Uint8Array([0x53, 0x05, 0x10]);

/**
 * encode a cosmos sign request as a hex string for QR display
 *
 * @param accountIndex - BIP44 account index (usually 0)
 * @param chainName - chain name (e.g. "noble", "osmosis", "celestia")
 * @param signDocBytes - canonical amino JSON sign doc as UTF-8 bytes
 * @returns hex string for QR display
 */
export function encodeCosmosSignRequest(
  accountIndex: number,
  chainName: string,
  signDocBytes: Uint8Array,
): string {
  const chainNameBytes = new TextEncoder().encode(chainName);

  if (chainNameBytes.length > 255) {
    throw new Error('chain name too long');
  }

  // calculate total size
  const totalSize =
    3 + // prelude
    4 + // account index
    1 + // chain name length
    chainNameBytes.length +
    4 + // sign doc length
    signDocBytes.length;

  const payload = new Uint8Array(totalSize);
  let offset = 0;

  // prelude
  payload.set(PRELUDE, offset);
  offset += 3;

  // account index (4 bytes LE)
  const accountView = new DataView(payload.buffer, offset, 4);
  accountView.setUint32(0, accountIndex, true);
  offset += 4;

  // chain name (length-prefixed)
  payload[offset] = chainNameBytes.length;
  offset += 1;
  payload.set(chainNameBytes, offset);
  offset += chainNameBytes.length;

  // sign doc bytes (length-prefixed, 4 bytes LE)
  const docLenView = new DataView(payload.buffer, offset, 4);
  docLenView.setUint32(0, signDocBytes.length, true);
  offset += 4;
  payload.set(signDocBytes, offset);

  if (totalSize > 2900) {
    console.warn(`cosmos sign request is ${totalSize} bytes, may not fit in a single QR code`);
  }

  return bytesToHex(payload);
}

/**
 * parse a cosmos signature response QR (64-byte r||s signature)
 *
 * @param hex - hex string from QR scan
 * @returns 64-byte signature Uint8Array
 */
export function parseCosmosSignatureQR(hex: string): Uint8Array {
  if (hex.length !== 128) {
    throw new Error(`expected 128 hex chars (64 bytes), got ${hex.length}`);
  }

  const bytes = hexToBytes(hex);

  if (bytes.length !== 64) {
    throw new Error(`expected 64 bytes, got ${bytes.length}`);
  }

  return bytes;
}

/**
 * check if a hex string looks like a cosmos signature response (exactly 64 bytes)
 */
export function isCosmosSignatureQR(hex: string): boolean {
  return /^[0-9a-fA-F]{128}$/.test(hex);
}

// --- hex utilities ---

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
