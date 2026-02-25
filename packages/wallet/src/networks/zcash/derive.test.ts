/**
 * test zcash transparent address derivation against known vectors
 *
 * test vector: BIP39 "abandon" x11 + "about" mnemonic (no passphrase)
 * path m/44'/133'/0'/0/0 → t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F
 *
 * cross-verified against @scure/bip32 (paulmillr's reference BIP32 implementation)
 *
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest';
import { deriveZcashTransparentAddress } from './derive';

// standard BIP39 test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('zcash transparent derivation', () => {
  test('derives valid t1 address from test mnemonic', () => {
    const addr = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 0, true);
    // must start with t1 (mainnet p2pkh)
    expect(addr.startsWith('t1')).toBe(true);
    // base58check addresses are typically 34-35 chars for zcash t-addr
    expect(addr.length).toBeGreaterThanOrEqual(33);
    expect(addr.length).toBeLessThanOrEqual(36);
  });

  test('known test vector: m/44h/133h/0h/0/0', () => {
    // "abandon x11 about" → m/44'/133'/0'/0/0
    // verified: BIP32 master key matches spec test vector 1, seed matches known BIP39 output
    const addr = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 0, true);
    expect(addr).toBe('t1XVXWCvpMgBvUaed4XDqWtgQgJSu1Ghz7F');
  });

  test('different indices produce different addresses', () => {
    const addr0 = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 0, true);
    const addr1 = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 1, true);
    const addr2 = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 2, true);
    expect(addr0).not.toBe(addr1);
    expect(addr1).not.toBe(addr2);
    expect(addr0).not.toBe(addr2);
  });

  test('different accounts produce different addresses', () => {
    const acc0 = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 0, true);
    const acc1 = deriveZcashTransparentAddress(TEST_MNEMONIC, 1, 0, true);
    expect(acc0).not.toBe(acc1);
  });

  test('mainnet vs testnet produce different addresses', () => {
    const main = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 0, true);
    const test_addr = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 0, false);
    expect(main).not.toBe(test_addr);
    expect(main.startsWith('t1')).toBe(true);
    expect(test_addr.startsWith('t')).toBe(true);
  });

  test('deterministic — same inputs always produce same output', () => {
    const a = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 0, true);
    const b = deriveZcashTransparentAddress(TEST_MNEMONIC, 0, 0, true);
    expect(a).toBe(b);
  });
});
