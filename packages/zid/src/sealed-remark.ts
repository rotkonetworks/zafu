/**
 * sealed-remark - encrypt a Noise init payload for Polkadot system.remark
 *
 * Polkadot remarks are public on-chain, so we seal the Noise init payload
 * using an ephemeral x25519 DH with the recipient's ed25519 pubkey
 * (converted to x25519). this leaks that *someone* sent *something* to
 * the recipient, but not the content.
 *
 * wire format:
 *   [4 bytes: magic "zSR\x01"]
 *   [32 bytes: ephemeral x25519 pubkey]
 *   [12 bytes: AES-GCM nonce]
 *   [N bytes: AES-256-GCM ciphertext + 16-byte tag]
 *
 * the ciphertext decrypts to a Noise init payload (same format as
 * noise-init-memo.ts, starting with "zNI\x01").
 */

import { x25519 } from '@noble/curves/ed25519'
import { edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { gcm } from '@noble/ciphers/aes'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { decodeNoiseInitMemo } from './noise-init-memo'
import type { NoiseInitPayload } from './noise-init-memo'

/** magic bytes: "zSR" + version 0x01 */
const MAGIC = new Uint8Array([0x7a, 0x53, 0x52, 0x01])

/** fixed overhead: magic(4) + ephemeral(32) + nonce(12) + GCM tag(16) = 64 */
const OVERHEAD = 4 + 32 + 12 + 16

/** HKDF info string for sealed remark key derivation */
const HKDF_INFO = new TextEncoder().encode('zafu-sealed-remark-v1')

/**
 * check if raw bytes begin with the sealed remark magic.
 */
export function isSealedRemark(remarkBytes: Uint8Array): boolean {
  if (remarkBytes.length < OVERHEAD) return false
  return (
    remarkBytes[0] === MAGIC[0] &&
    remarkBytes[1] === MAGIC[1] &&
    remarkBytes[2] === MAGIC[2] &&
    remarkBytes[3] === MAGIC[3]
  )
}

/**
 * encrypt a Noise init payload for a Polkadot system.remark.
 *
 * generates an ephemeral x25519 keypair, performs DH with the recipient's
 * ed25519 public key (converted to x25519), derives an AES-256-GCM key
 * via HKDF, and encrypts the payload.
 *
 * @param recipientEd25519Pub - recipient's ed25519 public key (32 bytes)
 * @param noiseInitPayload - the Noise init payload bytes to encrypt
 * @returns sealed remark bytes, or null on error
 */
export function encodeSealedRemark(
  recipientEd25519Pub: Uint8Array,
  noiseInitPayload: Uint8Array,
): Uint8Array | null {
  if (recipientEd25519Pub.length !== 32) return null
  if (noiseInitPayload.length === 0) return null

  try {
    // convert recipient ed25519 pubkey to x25519
    const recipientX25519Pub = edwardsToMontgomeryPub(recipientEd25519Pub)

    // generate ephemeral x25519 keypair
    const ephemeralPriv = randomBytes(32)
    const ephemeralPub = x25519.getPublicKey(ephemeralPriv)

    // DH: ephemeral priv * recipient x25519 pub
    const sharedSecret = x25519.getSharedSecret(ephemeralPriv, recipientX25519Pub)

    // derive AES-256-GCM key via HKDF-SHA256
    // salt = ephemeral pubkey (binds the key to this specific exchange)
    const aesKey = hkdf(sha256, sharedSecret, ephemeralPub, HKDF_INFO, 32)

    // encrypt with AES-256-GCM
    const nonce = randomBytes(12)
    const cipher = gcm(aesKey, nonce)
    const ciphertext = cipher.encrypt(noiseInitPayload)

    // assemble: magic + ephemeral pub + nonce + ciphertext (includes tag)
    const totalSize = 4 + 32 + 12 + ciphertext.length
    const out = new Uint8Array(totalSize)
    let offset = 0

    out.set(MAGIC, offset)
    offset += 4

    out.set(ephemeralPub, offset)
    offset += 32

    out.set(nonce, offset)
    offset += 12

    out.set(ciphertext, offset)

    // zeroize ephemeral private key and shared secret
    ephemeralPriv.fill(0)
    sharedSecret.fill(0)
    aesKey.fill(0)

    return out
  } catch {
    return null
  }
}

/**
 * decrypt a sealed remark using the recipient's ed25519 private key.
 *
 * @param myEd25519Priv - recipient's ed25519 private key (32 bytes seed)
 * @param remarkBytes - the sealed remark bytes from a system.remark extrinsic
 * @returns decoded Noise init payload, or null if decryption fails
 */
export function decodeSealedRemark(
  myEd25519Priv: Uint8Array,
  remarkBytes: Uint8Array,
): NoiseInitPayload | null {
  if (!isSealedRemark(remarkBytes)) return null
  if (myEd25519Priv.length !== 32) return null

  try {
    let offset = 4 // skip magic

    // extract ephemeral x25519 pubkey
    const ephemeralPub = remarkBytes.subarray(offset, offset + 32)
    offset += 32

    // extract nonce
    const nonce = remarkBytes.subarray(offset, offset + 12)
    offset += 12

    // remaining is ciphertext + GCM tag
    const ciphertext = remarkBytes.subarray(offset)
    if (ciphertext.length < 16) return null // at least the GCM tag

    // convert our ed25519 private key to x25519
    const myX25519Priv = edwardsToMontgomeryPriv(myEd25519Priv)

    // DH: my x25519 priv * ephemeral pub
    const sharedSecret = x25519.getSharedSecret(myX25519Priv, ephemeralPub)

    // derive AES-256-GCM key via HKDF-SHA256 (same params as encoder)
    const aesKey = hkdf(sha256, sharedSecret, ephemeralPub, HKDF_INFO, 32)

    // decrypt
    const cipher = gcm(aesKey, nonce)
    const plaintext = cipher.decrypt(ciphertext)

    // zeroize secrets
    myX25519Priv.fill(0)
    sharedSecret.fill(0)
    aesKey.fill(0)

    // the plaintext should be a valid Noise init payload
    return decodeNoiseInitMemo(plaintext)
  } catch {
    return null
  }
}
