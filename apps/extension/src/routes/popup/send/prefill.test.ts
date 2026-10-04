import { describe, expect, it } from 'vitest';
import { sendPrefill } from './prefill';

const none = new URLSearchParams();

describe('send prefill', () => {
  it('a card opened from a contact brings the recipient and the memo', () => {
    expect(
      sendPrefill({ prefillRecipient: 'u1bob', prefillMemo: 'ff5a05' }, none, undefined),
    ).toEqual({ recipient: 'u1bob', memo: 'ff5a05', amount: undefined });
  });

  it('a memo without a recipient still arrives', () => {
    expect(sendPrefill({ prefillMemo: 'hello' }, none, undefined)?.memo).toBe('hello');
  });

  it('a payment link fills from its query', () => {
    const q = new URLSearchParams({ to: 'zcash:u1x', amount_zat: '150000000', via: 'site' });
    expect(sendPrefill(undefined, q, 'hi')).toEqual({
      recipient: 'zcash:u1x',
      amount: '1.5',
      memo: 'hi',
      via: 'site',
    });
  });

  it('nothing to fill gives nothing', () => {
    expect(sendPrefill({ prefillAsset: 'upenumbra' }, none, undefined)).toBeUndefined();
  });
});
