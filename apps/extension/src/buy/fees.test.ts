import { describe, expect, it } from 'vitest';
import withFee from './fixtures/peer-quote-revolut-usd-100-fee20.json';
import noFee from './fixtures/peer-quote-revolut-usd-100-nofee.json';
import {
  byBest,
  fiatUnits,
  offPct,
  pct,
  rate3,
  ticketRows,
  toOffer,
  usdc2,
  zafuFeeOf,
  zafuReferral,
  type PeerQuoteRow,
} from './fees';
import { ZAFU_BUY_FEE_BPS, ZAFU_BUY_FEE_BPS_LIST, ZAFU_BUY_FEE_RECIPIENT } from '../config/ramps';

const rows = (d: { responseObject: { quotes: unknown[] } }) =>
  d.responseObject.quotes.map(q => toOffer(q as PeerQuoteRow));

describe('buy fees', () => {
  it('keeps the list rate and the beta rate as the constants the founder set', () => {
    expect(ZAFU_BUY_FEE_BPS_LIST).toBe(50);
    // free in beta: nothing charged, the normal rate kept to show struck through
    expect(ZAFU_BUY_FEE_BPS).toBe(0);
    expect(offPct()).toBe(100);
    expect(offPct(50, 20)).toBe(60);
    expect([pct(ZAFU_BUY_FEE_BPS_LIST), pct(20)]).toEqual(['0.5%', '0.2%']);
  });

  it("reconciles a live quote: gross - peer's fee - zafu's fee = what lands", () => {
    for (const o of rows(withFee)) {
      expect(o.gross - o.peerFee - o.zafuFee).toBe(o.net);
      // the contract pays the referral on the released amount
      expect(o.zafuFee).toBe(zafuFeeOf(o.gross, 20));
      expect(o.peerBps).toBe(95);
    }
    const [o] = rows(withFee);
    expect(usdc2(o!.gross)).toBe('98.04');
    expect(rate3(o!.rate)).toBe('1.020');
  });

  it('shows zafu in the free beta as the normal rate struck through, then free', () => {
    const [o] = rows(noFee);
    expect(o!.zafuFee).toBe(0n);
    const zafu = ticketRows(o!, 'usd', undefined, 'unknown').find(r => r.k === 'zafu');
    expect(zafu).toEqual({ k: 'zafu', struck: '0.5%', v: 'free in beta', tone: 'green' });
  });

  it('asks Peer for no fee without a recipient, and never an empty array', () => {
    expect(ZAFU_BUY_FEE_RECIPIENT).toBeNull();
    // no referralFees entry while the fee is 0, even once a recipient is set
    expect(zafuReferral()).toBeUndefined();
    expect(zafuReferral('0x2222222222222222222222222222222222222222')).toBeUndefined();
    expect(zafuReferral('0x2222222222222222222222222222222222222222', 20)).toEqual({
      recipient: '0x2222222222222222222222222222222222222222',
      feeBps: 20,
    });
  });

  it('orders sellers by what lands for the same fiat', () => {
    const sorted = rows(noFee).sort(byBest);
    expect(sorted[0]!.net >= sorted[sorted.length - 1]!.net).toBe(true);
    expect(sorted.at(-1)!.handle).toBe('rickzhrk');
  });

  it('reads typed amounts into 6-decimal fiat units', () => {
    expect(fiatUnits('100')).toBe(100_000_000n);
    expect(fiatUnits('1,250.5')).toBe(1_250_500_000n);
    expect(fiatUnits('0.000001')).toBe(1n);
    expect(fiatUnits('0')).toBeUndefined();
    expect(fiatUnits('abc')).toBeUndefined();
    expect(fiatUnits('1.1234567')).toBeUndefined();
  });
});
