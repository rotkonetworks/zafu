/**
 * Round endorsement: which election-authority key (ea_pk) a round's votes
 * encrypt to.
 *
 * A cast's ElGamal shares are encrypted to `ea_pk`, so a vote server that
 * swaps it can read every vote. The key is therefore taken only from the
 * bundled config, and only when a bundled trusted key signed it for this
 * round. Vote servers' copies are a cross-check, never the source.
 *
 * Scheme (vote-sdk `internal/votingconfig`, `auth_version: 2`, the only one
 * wallets accept): ed25519 over
 *   "zcash-shielded-vote:round-auth:v2" || round_id (32 bytes)
 *   || ea_pk (32 bytes) || pir_depth || tier0_layers || tier1_layers
 *   || poly_len (each u32 LE)
 * One valid signature from a trusted key endorses the round, as upstream.
 */

import { ed25519 } from '@noble/curves/ed25519';
import type { StaticVotingConfig, VotingServiceConfig } from './types';

const DOMAIN_V2 = new TextEncoder().encode('zcash-shielded-vote:round-auth:v2');

const fromB64 = (raw: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(raw), c => c.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const fromHex = (hex: string): Uint8Array | undefined =>
  /^([0-9a-f]{2})*$/.test(hex)
    ? Uint8Array.from(hex.match(/../g) ?? [], b => parseInt(b, 16))
    : undefined;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};

/** The auth_version 2 signed preimage, or undefined for a malformed input. */
export const roundAuthPayloadV2 = (
  roundIdHex: string,
  eaPk: Uint8Array,
  layout: NonNullable<VotingServiceConfig['pir_layout']>,
): Uint8Array | undefined => {
  const roundId = fromHex(roundIdHex);
  if (roundId?.length !== 32 || eaPk.length !== 32) {
    return undefined;
  }
  const parts = [
    DOMAIN_V2,
    roundId,
    eaPk,
    u32le(layout.pir_depth),
    u32le(layout.tier0_layers),
    u32le(layout.tier1_layers),
    u32le(layout.poly_len),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};

/**
 * The endorsed ea_pk (hex) for `roundIdHex`, or undefined when the bundled
 * config does not carry a valid auth_version 2 signature for it.
 */
export const endorsedEaPkHex = (
  trust: StaticVotingConfig,
  config: VotingServiceConfig,
  roundIdHex: string,
): string | undefined => {
  const entry = config.rounds[roundIdHex];
  const layout = config.pir_layout;
  if (entry?.auth_version !== 2 || !layout) {
    return undefined;
  }
  const eaPk = fromB64(entry.ea_pk);
  const payload = eaPk && roundAuthPayloadV2(roundIdHex, eaPk, layout);
  if (!eaPk || !payload) {
    return undefined;
  }
  const valid = entry.signatures.some(s => {
    const key = trust.trusted_keys.find(k => k.key_id === s.key_id);
    const pub = key && fromB64(key.pubkey);
    const sig = fromB64(s.sig);
    if (key?.alg !== 'ed25519' || s.alg !== 'ed25519' || pub?.length !== 32 || sig?.length !== 64) {
      return false;
    }
    try {
      return ed25519.verify(sig, payload, pub);
    } catch {
      return false;
    }
  });
  return valid ? toHex(eaPk) : undefined;
};
