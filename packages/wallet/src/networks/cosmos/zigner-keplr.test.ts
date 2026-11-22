import { describe, expect, it } from 'vitest';
import { serializeSignDoc } from '@cosmjs/amino';
import { fromBase64, toHex } from '@cosmjs/encoding';
import { adr036SignDoc, verifyAdr036 } from './adr036';
import { signKeplrAmino } from './signer';
import { zignerAminoRequest, zignerAminoSignature, zignerKeplrKey } from './zigner-keplr';

// a public test seed; it never holds funds. Its m/44'/118'/0'/0/0 key stands in
// for the key a zigner exports, and its signatures for zigner's 64-byte answers.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SIGNER = 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4';
const PUBKEY_HEX = toHex(fromBase64('Ak9OKtmcNNYLm6YoPJQxqEGK+GcyEpYfl6d7Y3f80Fti'));
const DATA = new TextEncoder().encode('hello from zafu');

/** what zigner answers for `doc`: the 64-byte r||s signature */
const zignerAnswer = async (doc: ReturnType<typeof adr036SignDoc>) =>
  fromBase64((await signKeplrAmino(MNEMONIC, 'cosmos', SIGNER, doc)).signatureB64);

describe('zignerKeplrKey', () => {
  it('derives the address on each chain from the exported key', () => {
    expect(zignerKeplrKey(PUBKEY_HEX, 'cosmos', 'cold')).toMatchObject({
      name: 'cold',
      algo: 'secp256k1',
      bech32Address: SIGNER,
    });
    expect(zignerKeplrKey(PUBKEY_HEX, 'juno', 'cold')?.bech32Address).toBe(
      'juno19rl4cm2hmr8afy4kldpxz3fka4jguq0a2jwxcf',
    );
  });

  it('has no key without a compressed public key', () => {
    expect(zignerKeplrKey(undefined, 'cosmos', 'cold')).toBeNull();
    expect(zignerKeplrKey('04abcd', 'cosmos', 'cold')).toBeNull();
  });
});

describe('an ADR-036 signature through zigner', () => {
  const doc = adr036SignDoc(SIGNER, DATA);

  it('asks zigner to sign the exact sign doc bytes', () => {
    const qr = zignerAminoRequest(0, 'cosmoshub', doc);
    expect(qr.startsWith('530510')).toBe(true);
    expect(qr.endsWith(toHex(serializeSignDoc(doc)))).toBe(true);
  });

  it("returns zigner's answer as keplr does, and it verifies", async () => {
    const res = zignerAminoSignature(PUBKEY_HEX, SIGNER, doc, await zignerAnswer(doc));
    expect(res.pub_key).toEqual({
      type: 'tendermint/PubKeySecp256k1',
      value: 'Ak9OKtmcNNYLm6YoPJQxqEGK+GcyEpYfl6d7Y3f80Fti',
    });
    expect(verifyAdr036('cosmos', SIGNER, DATA, res)).toBe(true);
  });

  it("refuses an answer for another request, or a key that doesn't own the signer", async () => {
    const other = await zignerAnswer(adr036SignDoc(SIGNER, new TextEncoder().encode('other')));
    expect(() => zignerAminoSignature(PUBKEY_HEX, SIGNER, doc, other)).toThrow(/scan again/);
    const answer = await zignerAnswer(doc);
    const stranger = 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';
    expect(() => zignerAminoSignature(PUBKEY_HEX, stranger, doc, answer)).toThrow(/does not own/);
  });
});
