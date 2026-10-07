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
import {
  accountCredentialId,
  createCredential,
  discoverableCredential,
  findCredential,
  legacyCredentialId,
  signAssertion,
} from './webauthn';
import { identityKey, signP256, verifyP256 } from './identity';

const MN =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MN2 = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const ID = identityKey(MN);
const ID2 = identityKey(MN2);
const NO_USER = new Uint8Array(0);
const ALICE = new TextEncoder().encode('user-alice');
const BOB = new TextEncoder().encode('user-bob');

const UV = 0x04;
const UP = 0x01;

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

  it.each([
    ['per rpId (made before v3)', NO_USER],
    ['per account (v3)', ALICE],
  ])('%s verifies with WebCrypto over authData || clientDataHash', async (_, user) => {
    const { publicKey, credentialId } = await createCredential(ID, rpId, user, true);
    const [credential] = [await findCredential(ID, rpId, [bytesToHex(credentialId)])];
    const cdh = webcrypto.getRandomValues(new Uint8Array(32));
    const { authenticatorData, signature } = signAssertion(
      ID,
      rpId,
      credential!,
      cdh,
      undefined,
      false,
    );
    expect(await rpVerifies(publicKey, signature, concat(authenticatorData, cdh))).toBe(true);
    // and covers the client data: another challenge does not verify under it
    const other = webcrypto.getRandomValues(new Uint8Array(32));
    expect(await rpVerifies(publicKey, signature, concat(authenticatorData, other))).toBe(false);
  });

  it('differs for every challenge', () => {
    const c = { id: new Uint8Array(16) };
    const a = signAssertion(ID, rpId, c, new Uint8Array(32).fill(1), undefined, false);
    const b = signAssertion(ID, rpId, c, new Uint8Array(32).fill(2), undefined, false);
    expect(bytesToHex(a.signature)).not.toBe(bytesToHex(b.signature));
  });

  it('claims presence (it runs only after the tap) and UV only when the person verified', async () => {
    const cdh = new Uint8Array(32);
    const c = { id: new Uint8Array(16) };
    expect(signAssertion(ID, rpId, c, cdh, undefined, false).authenticatorData[32]! & UV).toBe(0);
    expect(signAssertion(ID, rpId, c, cdh, undefined, true).authenticatorData[32]! & UV).toBe(UV);
    expect(signAssertion(ID, rpId, c, cdh, undefined, false).authenticatorData[32]! & UP).toBe(UP);
    expect((await createCredential(ID, rpId, NO_USER, false)).authenticatorData[32]! & UV).toBe(0);
  });
});

describe('passkey credential id', () => {
  it('per rpId: per user and per relying party, and carries no zafu marker', async () => {
    const id = async (i: Uint8Array, rp: string) =>
      bytesToHex((await createCredential(i, rp, NO_USER, true)).credentialId);
    const a = await id(ID, 'example.com');
    expect(a).toHaveLength(32);
    expect(a.startsWith(bytesToHex(new TextEncoder().encode('zafu:')))).toBe(false);
    expect(await id(ID2, 'example.com')).not.toBe(a);
    expect(await id(ID, 'example.org')).not.toBe(a);
    // deterministic: the same phrase restores the same id
    expect(await id(ID, 'example.com')).toBe(a);
  });

  it('per account: two accounts at one site share no key and no id', async () => {
    const alice = await createCredential(ID, 'example.com', ALICE, false);
    const bob = await createCredential(ID, 'example.com', BOB, false);
    const perRp = await createCredential(ID, 'example.com', NO_USER, false);
    expect(bytesToHex(alice.publicKey)).not.toBe(bytesToHex(bob.publicKey));
    expect(bytesToHex(alice.publicKey)).not.toBe(bytesToHex(perRp.publicKey));
    expect(bytesToHex(alice.credentialId)).not.toBe(bytesToHex(bob.credentialId));
    // the account's user id is not readable in its id
    expect(bytesToHex(alice.credentialId)).not.toContain(bytesToHex(ALICE));
    // and it restores from the phrase alone
    expect(bytesToHex((await createCredential(ID, 'example.com', ALICE, false)).credentialId)).toBe(
      bytesToHex(alice.credentialId),
    );
  });

  it('sign-in recovers the account (userHandle) from the id the site stored', async () => {
    const alice = await createCredential(ID, 'example.com', ALICE, false);
    const found = await findCredential(ID, 'example.com', ['00ff', bytesToHex(alice.credentialId)]);
    expect(bytesToHex(found!.userId!)).toBe(bytesToHex(ALICE));
    // and signs with that account's key
    const cdh = new Uint8Array(32).fill(7);
    const { authenticatorData, signature } = signAssertion(
      ID,
      'example.com',
      found!,
      cdh,
      undefined,
      false,
    );
    expect(await rpVerifies(alice.publicKey, signature, concat(authenticatorData, cdh))).toBe(true);
  });

  it('a usernameless sign-in finds the same account again', async () => {
    const alice = await createCredential(ID, 'example.com', ALICE, false);
    const d = await discoverableCredential(ID, 'example.com', ALICE);
    expect(bytesToHex(d.id)).toBe(bytesToHex(alice.credentialId));
    expect(d.userId).toEqual(ALICE);
    expect(bytesToHex((await discoverableCredential(ID, 'example.com')).id)).toBe(
      bytesToHex((await createCredential(ID, 'example.com', NO_USER, false)).credentialId),
    );
  });

  it('still answers the ids made before v3, legacy ids included', async () => {
    const perRp = (await createCredential(ID, 'example.com', NO_USER, true)).credentialId;
    const legacy = legacyCredentialId('example.com');
    expect(await findCredential(ID, 'example.com', [bytesToHex(legacy)])).toEqual({ id: legacy });
    expect(await findCredential(ID, 'example.com', ['00ff', bytesToHex(perRp)])).toEqual({
      id: perRp,
    });
  });

  it('answers nothing for another authenticator, another wallet or another site', async () => {
    const alice = bytesToHex(await accountCredentialId(ID, 'example.com', ALICE));
    expect(await findCredential(ID, 'example.com', ['00ff'])).toBeUndefined();
    expect(await findCredential(ID2, 'example.com', [alice])).toBeUndefined();
    expect(await findCredential(ID, 'example.org', [alice])).toBeUndefined();
    // a tampered id does not open
    const bent = alice.slice(0, -2) + (alice.endsWith('00') ? '01' : '00');
    expect(await findCredential(ID, 'example.com', [bent])).toBeUndefined();
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
