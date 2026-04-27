/**
 * Rotko Networks ed25519 public key for Zcash anchor attestation.
 *
 * Same key hardcoded in zigner (rust/constants/src/lib.rs).
 * Used to verify that anchor attestations are genuine before
 * including them in QR payloads for the air-gapped signer.
 *
 * Trust model: same as Parity's verifier key in Polkadot Vault.
 */
export const ROTKO_ZCASH_VERIFIER =
  'ab2672aa1d6f0cb441bd6e46e2a2bfe9abde56acc0c140fab32f98b47dda2651';

/**
 * Domain-separated attestation digest.
 * SHA-256("zcash-anchor-v1" || pubkey || anchor || height_le || mainnet_byte)
 *
 * Must match zigner's verification and zcli's signing exactly.
 */
export async function attestationDigest(
  verifierPubkey: Uint8Array,
  anchor: Uint8Array,
  height: number,
  mainnet: boolean,
): Promise<Uint8Array> {
  const heightBuf = new Uint8Array(4);
  new DataView(heightBuf.buffer).setUint32(0, height, true); // LE

  const msg = new Uint8Array([
    ...new TextEncoder().encode('zcash-anchor-v1'),
    ...verifierPubkey,
    ...anchor,
    ...heightBuf,
    mainnet ? 1 : 0,
  ]);

  const hash = await crypto.subtle.digest('SHA-256', msg);
  return new Uint8Array(hash);
}

/**
 * Verify an ed25519 attestation signature.
 * Returns true if the signature is valid for the given anchor parameters.
 */
export async function verifyAttestation(
  signature: Uint8Array,
  anchor: Uint8Array,
  height: number,
  mainnet: boolean,
): Promise<boolean> {
  if (signature.length !== 64) return false;

  const pubkeyBytes = hexToBytes(ROTKO_ZCASH_VERIFIER);
  const digest = await attestationDigest(pubkeyBytes, anchor, height, mainnet);

  // import rotko's ed25519 public key
  // slice() to get a fresh ArrayBuffer (avoids SharedArrayBuffer compat issues)
  const key = await crypto.subtle.importKey(
    'raw',
    pubkeyBytes.slice().buffer,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('Ed25519', key, signature.slice().buffer, digest.slice().buffer);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
