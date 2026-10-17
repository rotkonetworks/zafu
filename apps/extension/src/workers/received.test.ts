import { describe, expect, it } from 'vitest';
import { receivedFrom } from './received';

describe('money received, as the sound hears it', () => {
  it('counts a payment from someone, never change or a move between your own pockets', () => {
    const owned = [{ spent_by_txid: 'mine' }, {}];
    expect(
      receivedFrom(
        [{ txid: 'theirs' }, { txid: 'mine' }, { txid: 'other', is_change: true }, { txid: '' }],
        owned,
      ),
    ).toBe(1);
  });
});
