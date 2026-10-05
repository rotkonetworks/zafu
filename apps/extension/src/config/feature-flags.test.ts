import { describe, expect, it } from 'vitest';
import { nu63ActivationHeight } from './feature-flags';

describe('nu63ActivationHeight', () => {
  // both read off the chains (coinbase branch ids either side of the height)
  it('mainnet 3,428,143 and testnet 4,134,000', () => {
    expect(nu63ActivationHeight(true)).toBe(3_428_143);
    expect(nu63ActivationHeight(false)).toBe(4_134_000);
  });
});
