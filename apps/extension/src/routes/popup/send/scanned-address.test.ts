import { describe, expect, it } from 'vitest';
import { scannedAddress } from './scanned-address';

const HASH = '0x' + 'ab'.repeat(32);

describe('scannedAddress', () => {
  it('unwraps a Zigner penumbra export, including the old substrate: tag', () => {
    expect(scannedAddress(`penumbra:penumbra1xyz:${HASH}`)).toBe('penumbra1xyz');
    expect(scannedAddress(`substrate:penumbra1xyz:${HASH}`)).toBe('penumbra1xyz');
  });

  it('unwraps a Zigner zcash export', () => {
    expect(scannedAddress(`zcash:u1abc:${HASH}`)).toBe('u1abc');
  });

  it('leaves plain addresses and payment links alone', () => {
    expect(scannedAddress(' penumbra1xyz\n')).toBe('penumbra1xyz');
    expect(scannedAddress('zcash:u1abc?amount=1')).toBe('zcash:u1abc?amount=1');
    expect(scannedAddress('zcash:u1abc:0x1234')).toBe('zcash:u1abc:0x1234');
  });
});
