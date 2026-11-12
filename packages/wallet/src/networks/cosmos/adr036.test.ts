import { describe, expect, it } from 'vitest';
import { serializeSignDoc } from '@cosmjs/amino';
import { adr036SignDoc, describeArbitraryData, verifyAdr036 } from './adr036';
import { signKeplrAmino } from './signer';

// a public test seed; it never holds funds
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SIGNER = 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4';
const PUBKEY = 'Ak9OKtmcNNYLm6YoPJQxqEGK+GcyEpYfl6d7Y3f80Fti';
const utf8 = (s: string) => new TextEncoder().encode(s);
const sig = (pubkey: string, signature: string) => ({
  pub_key: { type: 'tendermint/PubKeySecp256k1', value: pubkey },
  signature,
});

// made with @keplr-wallet/cosmos 0.13.41 (makeADR36AminoSignDoc + serializeSignDoc)
// and @keplr-wallet/crypto (PrivKeySecp256k1.signDigest32) from the seed above
const KEPLR = [
  {
    data: utf8('hello from zafu'),
    doc: '{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":"aGVsbG8gZnJvbSB6YWZ1","signer":"cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4"}}],"sequence":"0"}',
    signature:
      'INXJIBwvKgWVWGvXWPfeiu4xfuvi5HJ6qErH8LpwszQZMdkXGZDHLj8LHFdikiXIbhNAKe3NhZGdMh+etdxz3w==',
  },
  {
    data: new Uint8Array([0, 1, 2, 0xff]),
    doc: '{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"","msgs":[{"type":"sign/MsgSignData","value":{"data":"AAEC/w==","signer":"cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4"}}],"sequence":"0"}',
    signature:
      '9ly6+ri5oN5THVIZZ/CuFIE8gadTaMFAzPLTfso+gMAUWbd6UiQBkhRb873icprQNM3FcrJMi3zVi8CWaTmGUw==',
  },
];

describe('adr036SignDoc', () => {
  it.each(KEPLR)('serializes to the bytes keplr signs', ({ data, doc }) => {
    const ours = adr036SignDoc(SIGNER, data);
    expect(JSON.stringify(ours)).toBe(doc);
    expect(new TextDecoder().decode(serializeSignDoc(ours))).toBe(doc);
  });
});

describe('signing an adr-036 doc with a hot key', () => {
  it.each(KEPLR)('gives the signature keplr gives', async ({ data, signature }) => {
    const res = await signKeplrAmino(MNEMONIC, 'cosmos', SIGNER, adr036SignDoc(SIGNER, data));
    expect(res.pubKeyB64).toBe(PUBKEY);
    expect(res.signatureB64).toBe(signature);
  });

  it('refuses a signer that is not this key', async () => {
    const other = 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd02';
    await expect(
      signKeplrAmino(MNEMONIC, 'cosmos', other, adr036SignDoc(other, utf8('x'))),
    ).rejects.toThrow();
  });
});

describe('verifyAdr036', () => {
  it.each(KEPLR)('accepts keplr signatures', ({ data, signature }) => {
    expect(verifyAdr036('cosmos', SIGNER, data, sig(PUBKEY, signature))).toBe(true);
  });

  it('accepts a signature keplr made in the wild', () => {
    // from the verify-keplr-sign crate's tests
    const juno = sig(
      'Avt8e5UqfoRAh0RBUzHCu9arv7UFEFdfcv657h6TtSZE',
      '9PrDYrTb1tv/TALC/lgRIIekfwNMBPOra0QpaAqNCbADXT8vR9n0SS7L2OSaXma3UMrOLGTbWlLDImNhcZVgzA==',
    );
    const signer = 'juno105asxv7pt0fzxlz642pf4svm29u39zxzdq2ad5';
    expect(verifyAdr036('juno', signer, utf8('test'), juno)).toBe(true);
    expect(verifyAdr036('juno', signer, utf8('not test'), juno)).toBe(false);
  });

  it('refuses a changed message, prefix, key or key type', () => {
    const [{ data, signature }] = KEPLR as [(typeof KEPLR)[number]];
    expect(verifyAdr036('cosmos', SIGNER, utf8('hello from zafu.'), sig(PUBKEY, signature))).toBe(
      false,
    );
    expect(verifyAdr036('osmo', SIGNER, data, sig(PUBKEY, signature))).toBe(false);
    expect(
      verifyAdr036(
        'cosmos',
        SIGNER,
        data,
        sig('Avt8e5UqfoRAh0RBUzHCu9arv7UFEFdfcv657h6TtSZE', signature),
      ),
    ).toBe(false);
    expect(
      verifyAdr036('cosmos', SIGNER, data, {
        pub_key: { type: 'ethermint/PubKeyEthSecp256k1', value: PUBKEY },
        signature,
      }),
    ).toBe(false);
    expect(verifyAdr036('cosmos', 'not an address', data, sig(PUBKEY, signature))).toBe(false);
    expect(verifyAdr036('cosmos', SIGNER, data, sig(PUBKEY, 'AAAA'))).toBe(false);
  });
});

describe('describeArbitraryData', () => {
  it('shows printable utf-8 as text', () => {
    expect(describeArbitraryData(utf8('sign in to zafu\nnonce: 7 · ok'))).toEqual({
      text: 'sign in to zafu\nnonce: 7 · ok',
      hex: false,
    });
  });

  it('shows bytes that are not text as hex', () => {
    expect(describeArbitraryData(new Uint8Array([0, 1, 2, 0xff]))).toEqual({
      text: '000102ff',
      hex: true,
    });
    expect(describeArbitraryData(new Uint8Array([0xc3, 0x28]))).toEqual({
      text: 'c328',
      hex: true,
    });
    expect(describeArbitraryData(utf8('a\u0007b'))).toEqual({ text: '610762', hex: true });
  });
});
