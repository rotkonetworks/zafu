import { describe, expect, it } from 'vitest';
import { PEER_REFERRAL_CODE, PEER_SELL_URL, isCashOutToken } from './ramps';

describe('cash out through peer', () => {
  it('is a swap into usdc on base and nothing else', () => {
    expect(isCashOutToken({ symbol: 'USDC', chain: 'base' })).toBe(true);
    expect(isCashOutToken({ symbol: 'usdc', chain: 'base' })).toBe(true);
    expect(isCashOutToken({ symbol: 'USDC', chain: 'eth' })).toBe(false);
    expect(isCashOutToken({ symbol: 'USDT', chain: 'base' })).toBe(false);
    expect(isCashOutToken(undefined)).toBe(false);
  });

  it("continues on peer's referrals page with the seller code", () => {
    expect(PEER_SELL_URL).toBe(`https://app.peer.xyz/referrals?referralCode=${PEER_REFERRAL_CODE}`);
  });
});
