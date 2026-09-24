import { describe, expect, it } from 'vitest';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import {
  deriveInjectiveWallet,
  deriveInjectiveAddress,
  isValidInjectiveAddress,
  parseInjectiveRecipient,
} from './derive';

const toHex = (b: Uint8Array) =>
  Array.from(b)
    .map(x => x.toString(16).padStart(2, '0'))
    .join('');

describe('injective derivation', () => {
  // Reference vector lifted from Keplr's packages/crypto/src/key.spec.ts
  // ("test eth address"): mnemonic + m/44'/60'/0'/0/0 -> this exact 20-byte
  // Ethereum-style address. If our derivation diverges from this, we would
  // hand out a wrong inj1 address and strand funds - so this is the gate.
  const KEPLR_MNEMONIC =
    'notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius';
  const KEPLR_ETH_ADDR = 'd38de26638cbf4f5c99bd8787fedfdb50c3f236a';

  it('matches Keplr: the 20-byte eth account bytes are byte-identical', async () => {
    const w = await deriveInjectiveWallet(KEPLR_MNEMONIC, 0);
    expect(toHex(w.addressBytes)).toBe(KEPLR_ETH_ADDR);
  });

  it('bech32-encodes those bytes with the inj prefix', async () => {
    const addr = await deriveInjectiveAddress(KEPLR_MNEMONIC, 0);
    expect(addr.startsWith('inj1')).toBe(true);
    // round-trip: decoding the inj address yields the same 20 bytes
    const { prefix, data } = fromBech32(addr);
    expect(prefix).toBe('inj');
    expect(toHex(data)).toBe(KEPLR_ETH_ADDR);
  });

  it('is deterministic and index-sensitive', async () => {
    const a0 = await deriveInjectiveAddress(KEPLR_MNEMONIC, 0);
    const a0again = await deriveInjectiveAddress(KEPLR_MNEMONIC, 0);
    const a1 = await deriveInjectiveAddress(KEPLR_MNEMONIC, 1);
    expect(a0).toBe(a0again);
    expect(a1).not.toBe(a0);
    expect(a1.startsWith('inj1')).toBe(true);
  });

  it('produces a 20-byte account (not the 20-byte cosmos ripemd address by luck)', async () => {
    const w = await deriveInjectiveWallet(KEPLR_MNEMONIC, 0);
    expect(w.addressBytes).toHaveLength(20);
    expect(w.publicKey).toHaveLength(33); // compressed secp256k1
  });

  describe('isValidInjectiveAddress', () => {
    it('accepts a real derived inj address', async () => {
      const addr = await deriveInjectiveAddress(KEPLR_MNEMONIC, 0);
      expect(isValidInjectiveAddress(addr)).toBe(true);
      expect(isValidInjectiveAddress(`  ${addr}  `)).toBe(true); // trims
    });

    it('rejects a checksum-broken address that startsWith("inj1") would pass', async () => {
      const addr = await deriveInjectiveAddress(KEPLR_MNEMONIC, 0);
      // flip one character in the data section - keeps the inj1 prefix but
      // breaks the bech32 checksum
      const i = addr.length - 5;
      const bad = addr.slice(0, i) + (addr[i] === 'q' ? 'p' : 'q') + addr.slice(i + 1);
      expect(bad.startsWith('inj1')).toBe(true);
      expect(isValidInjectiveAddress(bad)).toBe(false);
    });

    it('rejects a valid bech32 address with the wrong prefix', () => {
      // a well-formed cosmos1 address (valid checksum, wrong hrp)
      expect(isValidInjectiveAddress('cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxr8dwp')).toBe(false);
    });

    it('rejects empty / junk input', () => {
      expect(isValidInjectiveAddress('')).toBe(false);
      expect(isValidInjectiveAddress('inj1')).toBe(false);
      expect(isValidInjectiveAddress('not an address')).toBe(false);
    });
  });
});

describe('parseInjectiveRecipient', () => {
  // the same 20-byte account in both forms
  const hex = '0x8c7f1c9e9a0f2d3b4a5c6d7e8f9011223344556a';
  const inj = toBech32('inj', Uint8Array.from(hex.slice(2).match(/../g)!, h => parseInt(h, 16)));

  it('accepts inj1', () => {
    expect(parseInjectiveRecipient(inj)).toEqual({ ok: true, address: inj, fromHex: false });
  });
  it('accepts 0x and converts to the same inj1 account', () => {
    expect(parseInjectiveRecipient(hex)).toEqual({ ok: true, address: inj, fromHex: true });
  });
  it('rejects a mixed-case 0x with a bad checksum', () => {
    const bad = '0x8C7f1c9e9a0f2d3b4a5c6d7e8f9011223344556A';
    expect(parseInjectiveRecipient(bad)).toMatchObject({ ok: false });
  });
  it('names a penumbra address', () => {
    expect(parseInjectiveRecipient('penumbra1qagc0nutnx6v23c8w44z0qku8stu9')).toEqual({
      ok: false,
      problem: 'penumbra',
    });
  });
  it('names another chain', () => {
    const cosmos = toBech32('cosmos', new Uint8Array(20));
    expect(parseInjectiveRecipient(cosmos)).toEqual({
      ok: false,
      problem: 'other-chain',
      prefix: 'cosmos',
    });
  });
  it('catches a one-character typo as a checksum error', () => {
    const typo = inj.slice(0, -1) + (inj.endsWith('q') ? 'p' : 'q');
    expect(parseInjectiveRecipient(typo)).toEqual({ ok: false, problem: 'checksum' });
  });
  it('rejects junk', () => {
    expect(parseInjectiveRecipient('hello')).toEqual({ ok: false, problem: 'format' });
  });
});
