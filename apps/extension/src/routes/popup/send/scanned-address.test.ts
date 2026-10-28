import { describe, expect, it } from 'vitest';
import { OLD_ZIGNER_PENUMBRA, scannedAddress } from './scanned-address';

const HASH = '0x' + 'ab'.repeat(32);

describe('scannedAddress', () => {
  it('unwraps a fixed Zigner penumbra export', () => {
    expect(scannedAddress(`penumbra:penumbra1xyz:${HASH}`)).toEqual({ address: 'penumbra1xyz' });
  });

  it('refuses the substrate: penumbra export of Zigner 0.12.0 and older', () => {
    expect(scannedAddress(`substrate:penumbra1xyz:${HASH}`)).toEqual({
      address: '',
      refused: OLD_ZIGNER_PENUMBRA,
    });
  });

  it('unwraps a Zigner zcash export', () => {
    expect(scannedAddress(`zcash:u1abc:${HASH}`)).toEqual({ address: 'u1abc' });
  });

  it('leaves plain addresses and payment links alone', () => {
    expect(scannedAddress(' penumbra1xyz\n')).toEqual({ address: 'penumbra1xyz' });
    expect(scannedAddress('zcash:u1abc?amount=1')).toEqual({ address: 'zcash:u1abc?amount=1' });
    expect(scannedAddress('zcash:u1abc:0x1234')).toEqual({ address: 'zcash:u1abc:0x1234' });
  });
});
