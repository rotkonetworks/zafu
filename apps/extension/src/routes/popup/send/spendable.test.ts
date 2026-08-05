import { describe, expect, it } from 'vitest';
import { computeFeeZat, maxSendable, quoteSend, MARGINAL_FEE } from './spendable';

const zec = (n: number) => BigInt(Math.round(n * 1e8));

describe('computeFeeZat — ZIP-317, mirroring the worker', () => {
  it('prices a minimal shielded send at the 2-action floor', () => {
    // 1 spend, 1 shielded output, change -> max(1, 2, 2) = 2 actions
    expect(computeFeeZat(1, 1, 0, true)).toBe(MARGINAL_FEE * 2n);
  });

  it('is NOT a flat 10,000 once the spend count exceeds the floor', () => {
    // the assumption the send form used to ship: any wallet holding several
    // small notes pays more, and a send priced at 10,000 cannot be built
    expect(computeFeeZat(5, 1, 0, true)).toBe(MARGINAL_FEE * 5n);
    expect(computeFeeZat(5, 1, 0, true)).not.toBe(10_000n);
  });

  it('charges the transparent output on top of the shielded actions', () => {
    expect(computeFeeZat(1, 0, 1, true)).toBe(MARGINAL_FEE * 3n);
  });

  it('applies the user multiplier and never drops below the consensus floor', () => {
    expect(computeFeeZat(1, 1, 0, true, 2)).toBe(MARGINAL_FEE * 4n);
    expect(computeFeeZat(1, 1, 0, true, 0.5)).toBe(MARGINAL_FEE * 2n);
    expect(computeFeeZat(1, 1, 0, true, NaN)).toBe(MARGINAL_FEE * 2n);
  });
});

describe('maxSendable', () => {
  it('deducts the fee the max transaction would actually pay', () => {
    const notes = [zec(1), zec(1), zec(1)];
    const max = maxSendable(notes, { transparentRecipient: false });
    // 3 spends, 1 output, no change -> 3 actions
    expect(max.feeZat).toBe(MARGINAL_FEE * 3n);
    expect(max.amountZat).toBe(zec(3) - MARGINAL_FEE * 3n);
  });

  it('produces an amount that is actually buildable', () => {
    const notes = [zec(0.5), zec(0.25), zec(0.1), zec(0.05)];
    const max = maxSendable(notes, { transparentRecipient: false });
    const quote = quoteSend(notes, max.amountZat, { transparentRecipient: false });
    expect(quote.ok).toBe(true);
  });

  it('the old flat-fee max was NOT buildable for a many-note wallet', () => {
    const notes = [zec(0.1), zec(0.1), zec(0.1), zec(0.1), zec(0.1)];
    const total = notes.reduce((s, v) => s + v, 0n);
    const oldMax = total - 10_000n; // what the form used to offer
    expect(quoteSend(notes, oldMax, { transparentRecipient: false }).ok).toBe(false);
  });

  it('reports zero, not a negative, when the fee exceeds the balance', () => {
    const max = maxSendable([1000n], { transparentRecipient: false });
    expect(max.amountZat).toBe(0n);
  });

  it('is empty for a wallet with no notes in the pool', () => {
    expect(maxSendable([], { transparentRecipient: false }).amountZat).toBe(0n);
  });

  it('costs more to a transparent recipient', () => {
    const notes = [zec(1)];
    const shielded = maxSendable(notes, { transparentRecipient: false });
    const transparent = maxSendable(notes, { transparentRecipient: true });
    expect(transparent.feeZat).toBeGreaterThan(shielded.feeZat);
    expect(transparent.amountZat).toBeLessThan(shielded.amountZat);
  });

  it('honours the fee multiplier', () => {
    const notes = [zec(1)];
    const single = maxSendable(notes, { transparentRecipient: false });
    const doubled = maxSendable(notes, { transparentRecipient: false, feeMultiplier: 2 });
    expect(doubled.feeZat).toBe(single.feeZat * 2n);
  });
});

describe('quoteSend — the check that used to happen after a two-minute prove', () => {
  it('accepts an amount the notes cover with fee', () => {
    const q = quoteSend([zec(1)], zec(0.5), { transparentRecipient: false });
    expect(q.ok).toBe(true);
    expect(q.nSpends).toBe(1);
  });

  it('rejects an amount that only fits if the fee is ignored', () => {
    const q = quoteSend([zec(1)], zec(1), { transparentRecipient: false });
    expect(q.ok).toBe(false);
    expect(q.error).toBe('insufficient');
  });

  it('selects largest-first, as the worker does', () => {
    const q = quoteSend([zec(0.1), zec(1), zec(0.2)], zec(0.9), { transparentRecipient: false });
    expect(q.nSpends).toBe(1);
  });

  it('rejects a zero or negative amount', () => {
    expect(quoteSend([zec(1)], 0n, { transparentRecipient: false }).ok).toBe(false);
  });

  it('rejects everything when the pool is empty, whatever the other pool holds', () => {
    // the orchard-funds-but-no-ironwood case: the form must not offer this
    const q = quoteSend([], zec(0.01), { transparentRecipient: false });
    expect(q.ok).toBe(false);
    expect(q.error).toBe('insufficient');
  });
});
