/**
 * Passkey assertions must verify the way a relying party verifies them:
 * WebCrypto ECDSA P-256 with SHA-256 over authData || clientDataHash. Before
 * the prehash fix noble signed only the first 32 bytes (the rpIdHash), so every
 * assertion for a site was the same bytes and no spec-following RP accepted it.
 */
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { p256 } from '@noble/curves/p256';
import { bytesToHex } from '@noble/hashes/utils';
import { createCredential, legacyCredentialId, pickCredentialId, signAssertion } from './webauthn';
import { signP256, verifyP256 } from './identity';

const MN =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MN2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const UV = 0x04;

/** WebCrypto ES256 verify, as a relying party does it */
const rpVerifies = async (pub: Uint8Array, derSig: Uint8Array, signed: Uint8Array) => {
  const key = await webcrypto.subtle.importKey(
    'raw',
    pub,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const raw = p256.Signature.fromDER(derSig).toCompactRawBytes();
  return webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, signed);
};

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

describe('passkey assertion', () => {
  const rpId = 'example.com';
  const { publicKey } = createCredential(MN, rpId, true);

  it('verifies with WebCrypto ECDSA P-256 SHA-256 over authData || clientDataHash', async () => {
    const cdh = webcrypto.getRandomValues(new Uint8Array(32));
    const { authenticatorData, signature } = signAssertion(MN, rpId, cdh, undefined, false);
    expect(await rpVerifies(publicKey, signature, concat(authenticatorData, cdh))).toBe(true);
    // and covers the client data: another challenge does not verify under it
    const other = webcrypto.getRandomValues(new Uint8Array(32));
    expect(await rpVerifies(publicKey, signature, concat(authenticatorData, other))).toBe(false);
  });

  it('differs for every challenge', () => {
    const a = signAssertion(MN, rpId, new Uint8Array(32).fill(1), undefined, false);
    const b = signAssertion(MN, rpId, new Uint8Array(32).fill(2), undefined, false);
    expect(bytesToHex(a.signature)).not.toBe(bytesToHex(b.signature));
  });

  it('sets UV only when the person verified', () => {
    const cdh = new Uint8Array(32);
    expect(signAssertion(MN, rpId, cdh, undefined, false).authenticatorData[32]! & UV).toBe(0);
    expect(signAssertion(MN, rpId, cdh, undefined, true).authenticatorData[32]! & UV).toBe(UV);
    expect(createCredential(MN, rpId, false).authenticatorData[32]! & UV).toBe(0);
  });
});

describe('passkey credential id', () => {
  it('is per user and per relying party, and carries no zafu marker', () => {
    const a = createCredential(MN, 'example.com', true).credentialId;
    expect(a).toHaveLength(16);
    expect(new TextDecoder().decode(a.slice(0, 5))).not.toBe('zafu:');
    expect(bytesToHex(createCredential(MN2, 'example.com', true).credentialId)).not.toBe(
      bytesToHex(a),
    );
    expect(bytesToHex(createCredential(MN, 'example.org', true).credentialId)).not.toBe(
      bytesToHex(a),
    );
    // deterministic: the same phrase restores the same id
    expect(bytesToHex(createCredential(MN, 'example.com', true).credentialId)).toBe(bytesToHex(a));
  });

  it('answers with the id the relying party stored, legacy ids included', () => {
    const current = createCredential(MN, 'example.com', true).credentialId;
    const legacy = legacyCredentialId('example.com');
    expect(pickCredentialId(MN, 'example.com', undefined)).toEqual(current);
    expect(pickCredentialId(MN, 'example.com', [bytesToHex(legacy)])).toEqual(legacy);
    expect(pickCredentialId(MN, 'example.com', ['00ff', bytesToHex(current)])).toEqual(current);
    // only another authenticator's credentials: not ours to answer
    expect(pickCredentialId(MN, 'example.com', ['00ff'])).toBeUndefined();
  });
});

describe('es256 site signing', () => {
  const origin = 'https://example.com';

  it('signs the whole challenge, verifiable with WebCrypto', async () => {
    const long = webcrypto.getRandomValues(new Uint8Array(80));
    const { signature, publicKey } = signP256(MN, origin, long);
    const pub = Uint8Array.from(Buffer.from(publicKey, 'hex'));
    const der = Uint8Array.from(Buffer.from(signature, 'hex'));
    expect(await rpVerifies(pub, der, long)).toBe(true);
    expect(verifyP256(publicKey, signature, long)).toBe(true);
    // a byte past offset 32 matters now
    const tail = long.slice();
    tail[70] = tail[70]! ^ 1;
    expect(verifyP256(publicKey, signature, tail)).toBe(false);
    expect(signP256(MN, origin, tail).signature).not.toBe(signature);
  });

  it('follows the ZID generation, and generation 0 keeps the old key', () => {
    const c = new Uint8Array(32);
    const g0 = signP256(MN, origin, c).publicKey;
    expect(signP256(MN, origin, c, undefined, 0).publicKey).toBe(g0);
    expect(signP256(MN, origin, c, undefined, 1).publicKey).not.toBe(g0);
  });
});
