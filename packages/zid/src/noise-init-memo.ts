/**
 * noise-init-memo - encode/decode a Noise IK pre-handshake payload
 * that fits inside a 512-byte Zcash shielded memo.
 *
 * wire format:
 *   [4 bytes: magic "zNI\x01"]
 *   [32 bytes: initiator ed25519 pubkey]
 *   [32 bytes: initiator ephemeral x25519 pubkey (Noise e)]
 *   [2 bytes: relay URL length, big-endian]
 *   [N bytes: relay URL UTF-8]
 *   [remaining: optional app payload]
 *
 * the ephemeral x25519 key IS the Noise `e` value - the responder uses it
 * directly in the handshake, saving a round trip. the initiator commits to
 * the handshake before the memo is even confirmed on-chain.
 */

/** maximum memo size (Zcash Orchard/Sapling) */
const MEMO_MAX = 512

/** magic bytes: "zNI" + version 0x01 */
const MAGIC = new Uint8Array([0x7a, 0x4e, 0x49, 0x01])

/** fixed header: magic(4) + ed25519(32) + x25519(32) + url_len(2) = 70 */
const HEADER_SIZE = 4 + 32 + 32 + 2

/** relay URL must leave room for at least the header in 512 bytes */
const MAX_RELAY_URL_LEN = 256

export interface NoiseInitPayload {
  /** initiator's ed25519 public key (32 bytes) */
  initiatorPubkey: Uint8Array
  /** initiator's ephemeral x25519 public key - the Noise `e` (32 bytes) */
  ephemeralX25519Pub: Uint8Array
  /** relay URL where the responder should connect */
  relayUrl: string
  /** optional application-level payload */
  appPayload?: Uint8Array
}

/**
 * check if raw memo bytes begin with the Noise init magic.
 * fast check - no allocation, no parsing.
 */
export function isNoiseInitMemo(memoBytes: Uint8Array): boolean {
  if (memoBytes.length < HEADER_SIZE) return false
  return (
    memoBytes[0] === MAGIC[0] &&
    memoBytes[1] === MAGIC[1] &&
    memoBytes[2] === MAGIC[2] &&
    memoBytes[3] === MAGIC[3]
  )
}

/**
 * encode a Noise init payload into a memo-sized Uint8Array (max 512 bytes).
 * returns null if the payload would exceed 512 bytes.
 */
export function encodeNoiseInitMemo(
  initiatorPubkey: Uint8Array,
  ephemeralX25519Pub: Uint8Array,
  relayUrl: string,
  appPayload?: Uint8Array,
): Uint8Array | null {
  if (initiatorPubkey.length !== 32) return null
  if (ephemeralX25519Pub.length !== 32) return null

  const urlBytes = new TextEncoder().encode(relayUrl)
  if (urlBytes.length > MAX_RELAY_URL_LEN) return null

  const totalSize = HEADER_SIZE + urlBytes.length + (appPayload?.length ?? 0)
  if (totalSize > MEMO_MAX) return null

  const out = new Uint8Array(totalSize)
  let offset = 0

  // magic
  out.set(MAGIC, offset)
  offset += 4

  // initiator ed25519 pubkey
  out.set(initiatorPubkey, offset)
  offset += 32

  // initiator ephemeral x25519 pubkey (Noise e)
  out.set(ephemeralX25519Pub, offset)
  offset += 32

  // relay URL length (big-endian u16)
  out[offset] = (urlBytes.length >> 8) & 0xff
  out[offset + 1] = urlBytes.length & 0xff
  offset += 2

  // relay URL
  out.set(urlBytes, offset)
  offset += urlBytes.length

  // optional app payload
  if (appPayload && appPayload.length > 0) {
    out.set(appPayload, offset)
  }

  return out
}

/**
 * decode a Noise init memo. returns null if the memo is malformed
 * or does not have the correct magic bytes.
 */
export function decodeNoiseInitMemo(memoBytes: Uint8Array): NoiseInitPayload | null {
  if (!isNoiseInitMemo(memoBytes)) return null

  // strip trailing zero padding (Zcash pads memos to 512 bytes)
  let end = memoBytes.length
  while (end > HEADER_SIZE && memoBytes[end - 1] === 0) end--
  const trimmed = memoBytes.subarray(0, end)

  if (trimmed.length < HEADER_SIZE) return null

  let offset = 4 // skip magic

  const initiatorPubkey = trimmed.slice(offset, offset + 32)
  offset += 32

  const ephemeralX25519Pub = trimmed.slice(offset, offset + 32)
  offset += 32

  const urlLen = (trimmed[offset] << 8) | trimmed[offset + 1]
  offset += 2

  // validate relay URL length
  if (urlLen > MAX_RELAY_URL_LEN) return null
  if (offset + urlLen > trimmed.length) return null

  let relayUrl: string
  try {
    relayUrl = new TextDecoder('utf-8', { fatal: true }).decode(
      trimmed.subarray(offset, offset + urlLen),
    )
  } catch {
    return null
  }
  offset += urlLen

  // remaining bytes are optional app payload
  const appPayload = offset < trimmed.length
    ? trimmed.slice(offset)
    : undefined

  return { initiatorPubkey, ephemeralX25519Pub, relayUrl, appPayload }
}
