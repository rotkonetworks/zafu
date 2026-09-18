import { describe, expect, it } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveInjectiveWallet } from './derive';
import {
  signEthSecp256k1,
  encodeEthSecp256k1PubKey,
  ethSecp256k1PubKeyAny,
  ETHSECP256K1_PUBKEY_TYPE_URL,
} from './sign';

const KEPLR_MNEMONIC =
  'notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius';
const enc = (s: string) => new TextEncoder().encode(s);
const toHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

describe('injective signing', () => {
  it('signs over the keccak256 digest and verifies (round-trip)', async () => {
    const w = await deriveInjectiveWallet(KEPLR_MNEMONIC, 0);
    const signBytes = enc('a canonical cosmos SignDoc goes here');

    const sig = signEthSecp256k1(w.privateKey, signBytes);
    expect(sig).toHaveLength(64); // r(32) || s(32), no recovery byte

    // the signature verifies against keccak256(signBytes) - the Ethermint digest
    const digest = keccak_256(signBytes);
    const pub = secp256k1.getPublicKey(w.privateKey, true);
    expect(secp256k1.verify(sig, digest, pub)).toBe(true);
  });

  it('does NOT verify against the sha256 digest (proves it is keccak, not cosmos)', async () => {
    const { sha256 } = await import('@noble/hashes/sha2');
    const w = await deriveInjectiveWallet(KEPLR_MNEMONIC, 0);
    const signBytes = enc('msg');
    const sig = signEthSecp256k1(w.privateKey, signBytes);
    const pub = secp256k1.getPublicKey(w.privateKey, true);
    expect(secp256k1.verify(sig, sha256(signBytes), pub)).toBe(false);
  });

  it('is deterministic (RFC6979) and rejects a tampered message', async () => {
    const w = await deriveInjectiveWallet(KEPLR_MNEMONIC, 0);
    const msg = enc('deterministic');
    const a = signEthSecp256k1(w.privateKey, msg);
    const b = signEthSecp256k1(w.privateKey, msg);
    expect(toHex(a)).toBe(toHex(b));

    const pub = secp256k1.getPublicKey(w.privateKey, true);
    expect(secp256k1.verify(a, keccak_256(enc('tampered')), pub)).toBe(false);
  });

  it('enforces low-S (s < n/2)', async () => {
    const w = await deriveInjectiveWallet(KEPLR_MNEMONIC, 0);
    const sig = signEthSecp256k1(w.privateKey, enc('lows'));
    const s = BigInt('0x' + toHex(sig.slice(32)));
    const halfN = secp256k1.CURVE.n / 2n;
    expect(s <= halfN).toBe(true);
  });

  it('encodes the ethsecp256k1 pubkey Any with the injective type URL', async () => {
    const w = await deriveInjectiveWallet(KEPLR_MNEMONIC, 0);
    const pub = secp256k1.getPublicKey(w.privateKey, true);

    const body = encodeEthSecp256k1PubKey(pub);
    expect(body[0]).toBe(0x0a); // field 1, length-delimited
    expect(body[1]).toBe(33); // pubkey length
    expect(body).toHaveLength(35);
    expect(toHex(body.slice(2))).toBe(toHex(pub));

    const any = ethSecp256k1PubKeyAny(pub);
    expect(any.typeUrl).toBe(ETHSECP256K1_PUBKEY_TYPE_URL);
    expect(any.typeUrl).toBe('/injective.crypto.v1beta1.ethsecp256k1.PubKey');
    expect(toHex(any.value)).toBe(toHex(body));
  });

  it('rejects a non-33-byte pubkey', () => {
    expect(() => encodeEthSecp256k1PubKey(new Uint8Array(65))).toThrow();
  });
});
