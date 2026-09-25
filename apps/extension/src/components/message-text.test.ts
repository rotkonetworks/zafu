import { describe, expect, it } from 'vitest';
import { splitPaymentLinks } from './message-text';

const T = 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf';

describe('splitPaymentLinks', () => {
  it('pulls a payment link out of a sentence, without its trailing punctuation', () => {
    expect(splitPaymentLinks(`pay me here: zcash:${T}?amount=0.5. thanks`)).toEqual([
      'pay me here: ',
      { uri: `zcash:${T}?amount=0.5` },
      '. thanks',
    ]);
  });

  it('handles several links and none', () => {
    expect(splitPaymentLinks(`zcash:${T} or ZCASH:${T}?amount=1`)).toEqual([
      { uri: `zcash:${T}` },
      ' or ',
      { uri: `ZCASH:${T}?amount=1` },
    ]);
    expect(splitPaymentLinks('no links here')).toEqual(['no links here']);
  });
});
