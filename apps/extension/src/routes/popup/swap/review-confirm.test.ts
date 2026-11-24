import { describe, expect, it } from 'vitest';
import { PRICE_MOVED_NOTICE, reviewConfirmLabel } from './review-confirm';

describe('reviewConfirmLabel', () => {
  it('keeps the first-press wording', () => {
    expect(reviewConfirmLabel({ isFromZec: true, kind: 'zigner' })).toBe('sign with zigner');
    expect(reviewConfirmLabel({ isFromZec: true, kind: 'hot' })).toBe('swap');
    expect(reviewConfirmLabel({ isFromZec: false, kind: 'zigner' })).toBe('show deposit address');
    expect(reviewConfirmLabel({ isFromZec: true, kind: 'hot', askCustody: true })).toBe(
      'understood · swap',
    );
  });

  it('uses a distinct label when the firm quote moved', () => {
    expect(reviewConfirmLabel({ isFromZec: true, kind: 'zigner', priceMoved: true })).toBe(
      'looks right · sign with zigner',
    );
    expect(reviewConfirmLabel({ isFromZec: true, kind: 'hot', priceMoved: true })).toBe(
      'looks right · swap',
    );
    expect(reviewConfirmLabel({ isFromZec: false, kind: 'hot', priceMoved: true })).toBe(
      'looks right · show deposit address',
    );
  });

  it('the notice is one calm line', () => {
    expect(PRICE_MOVED_NOTICE).toBe('the price moved · please look again');
    expect(PRICE_MOVED_NOTICE).toBe(PRICE_MOVED_NOTICE.toLowerCase());
    expect(PRICE_MOVED_NOTICE).not.toMatch(/!/);
  });
});
