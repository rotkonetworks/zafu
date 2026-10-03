import { beforeEach, describe, expect, it } from 'vitest';
import { Key } from '@repo/encryption/key';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import noFee from './fixtures/peer-quote-revolut-usd-100-nofee.json';
import { toOffer, type PeerQuoteRow } from './fees';
import {
  INTENT_LIFETIME_MS,
  advance,
  cardLines,
  clock,
  loadOffer,
  migrateBuy,
  resume,
  startBuy,
  type OpenBuy,
} from './machine';
import { readOpenBuy, writeOpenBuy } from './store';
import { markHydrated } from '../state/encrypted-storage';

const offer = toOffer(noFee.responseObject.quotes[0] as PeerQuoteRow);
const T0 = 1_800_000_000_000;
const base = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' as const;

const paying = (): OpenBuy =>
  advance(
    startBuy({ app: 'revolut', currency: 'usd', base, zcash: 'u1test', offer }, T0),
    'pay',
    { intentHash: '0xabc', expiresAt: T0 + INTENT_LIFETIME_MS },
    T0 + 3000,
  );

describe('the buy state machine', () => {
  it('stamps when each stage began and keeps earlier stamps', () => {
    const b = paying();
    expect(b.at).toEqual({ reserving: T0, pay: T0 + 3000 });
    expect(advance(b, 'pay', {}, T0 + 9999).at['pay']).toBe(T0 + 3000);
  });

  it('round-trips the offer through json without losing a unit', () => {
    const b = JSON.parse(JSON.stringify(paying())) as OpenBuy;
    expect(loadOffer(b.offer)).toEqual(offer);
  });

  it('resumes an unpaid buy in place while the intent is held', () => {
    const b = paying();
    expect(resume(b, { now: T0 + 60_000, intent: 'held' })).toBe(b);
  });

  it('marks it expired after the 6 hours, whatever the chain says', () => {
    expect(resume(paying(), { now: T0 + INTENT_LIFETIME_MS, intent: 'held' }).stage).toBe(
      'expired',
    );
  });

  it('moves on to released only when the chain says the intent was released', () => {
    const b = advance(paying(), 'confirming', {}, T0 + 70_000);
    expect(resume(b, { now: T0 + 80_000, intent: 'fulfilled' }).stage).toBe('released');
    expect(resume(paying(), { now: T0 + 80_000, intent: 'fulfilled' }).stage).toBe('released');
    // nothing about a balance moves it: leftover usdc from a refund is not a release
    expect(resume(b, { now: T0 + 80_000 })).toBe(b);
  });

  it('never ends a paid buy on time alone: held past 6 h keeps going', () => {
    const b = advance(paying(), 'confirming', {}, T0 + 70_000);
    const late = T0 + INTENT_LIFETIME_MS + 60_000;
    expect(resume(b, { now: late, intent: 'held' })).toBe(b);
    expect(resume(b, { now: late })).toBe(b);
  });

  it('a paid buy whose hold ended without a release is lapsed, still watched for a release', () => {
    const b = advance(paying(), 'confirming', {}, T0 + 70_000);
    const lapsed = resume(b, { now: T0 + INTENT_LIFETIME_MS + 1, intent: 'gone' });
    expect(lapsed.stage).toBe('lapsed');
    expect(resume(lapsed, { now: T0 + INTENT_LIFETIME_MS + 9, intent: 'gone' })).toBe(lapsed);
    // a seller's release by hand, after a dispute
    expect(resume(lapsed, { now: T0 + 2 * INTENT_LIFETIME_MS, intent: 'fulfilled' }).stage).toBe(
      'released',
    );
    const card = cardLines(lapsed, T0 + INTENT_LIFETIME_MS + 9);
    expect(card.status).not.toMatch(/nothing was taken/);
    expect(card.title).toMatch(/you paid/);
  });

  it("reads an older build's 'expired after i've paid' as lapsed", () => {
    const paid = advance(paying(), 'confirming', {}, T0 + 70_000);
    const old = advance(paid, 'expired', {}, T0 + INTENT_LIFETIME_MS);
    expect(migrateBuy(old)).toMatchObject({ stage: 'lapsed' });
    // never paid: it really did just expire
    const unpaid = advance(paying(), 'expired', {}, T0 + INTENT_LIFETIME_MS);
    expect(migrateBuy(unpaid)).toBe(unpaid);
  });

  it('settles a swap from 1click status only', () => {
    const s = advance(paying(), 'swapping', {
      near: {
        depositAddress: '0xd',
        amountIn: '97107843',
        amountOut: '7368542',
        minAmountOut: '7294856',
        quotedAt: T0,
      },
    });
    expect(resume(s, { now: T0, swap: 'pending' })).toBe(s);
    expect(resume(s, { now: T0, swap: 'success', swapOut: '7370000' })).toMatchObject({
      stage: 'done',
      arrived: '7370000',
    });
    expect(resume(s, { now: T0, swap: 'refunded' }).stage).toBe('refunded');
  });

  it('a leg saved before its send whose deposit never came is quoted afresh after its deadline', () => {
    const near = {
      depositAddress: '0xd',
      amountIn: '97107843',
      amountOut: '7368542',
      minAmountOut: '7294856',
      quotedAt: T0,
      deadline: new Date(T0 + 7_200_000).toISOString(),
    };
    const s = advance(paying(), 'swapping', { near });
    expect(resume(s, { now: T0 + 60_000, swap: 'pending', noDeposit: true })).toBe(s);
    expect(resume(s, { now: T0 + 7_300_000, swap: 'pending', noDeposit: true })).toMatchObject({
      stage: 'released',
      near: undefined,
    });
    // a deposit it saw, or a send it recorded, keeps being followed
    expect(resume(s, { now: T0 + 7_300_000, swap: 'pending', noDeposit: false })).toBe(s);
    const sent = { ...s, depositTx: '0xabc' as const };
    expect(resume(sent, { now: T0 + 7_300_000, swap: 'pending', noDeposit: true })).toBe(sent);
  });

  it('gives the home card the stage and the real clock', () => {
    const line = cardLines(paying(), T0 + 3000 + 60_000);
    expect(line.status).toBe(`pay ${offer.handle} $100.00 on revolut · 5:58:57 left`);
    expect(clock(-5)).toBe('0:00');
    expect(clock(83_000)).toBe('1:23');
  });
});

describe('the open buy at rest', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    markHydrated();
  });

  const unlock = async () => {
    const { key } = await Key.create('pw');
    await sessionExtStorage.set('passwordKey', await key.toJson());
  };

  it('is sealed, never plaintext', async () => {
    await unlock();
    expect(await writeOpenBuy(paying())).toBe(true);
    const raw = (await chrome.storage.local.get('openBuy'))['openBuy'] as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['encrypted']);
    expect(JSON.stringify(raw)).not.toContain(offer.handle);
    expect((await readOpenBuy())?.stage).toBe('pay');
  });

  it('reads as nothing while locked, and writes nothing', async () => {
    await unlock();
    await writeOpenBuy(paying());
    await chrome.storage.session.clear();
    expect(await readOpenBuy()).toBeNull();
    expect(await writeOpenBuy(paying())).toBe(false);
    // the sealed record is untouched
    expect(Object.keys((await chrome.storage.local.get('openBuy'))['openBuy'] as object)).toEqual([
      'encrypted',
    ]);
  });

  it("an older build's sealed 'expired after i've paid' opens as lapsed", async () => {
    await unlock();
    const old = advance(
      advance(paying(), 'confirming', {}, T0 + 70_000),
      'expired',
      {},
      T0 + INTENT_LIFETIME_MS,
    );
    await writeOpenBuy(old);
    expect(Object.keys((await chrome.storage.local.get('openBuy'))['openBuy'] as object)).toEqual([
      'encrypted',
    ]);
    expect(await readOpenBuy()).toMatchObject({ stage: 'lapsed', offer: old.offer });
  });

  it('ignores an old or foreign shape instead of crashing', async () => {
    await unlock();
    await chrome.storage.local.set({ openBuy: { stage: 'pay' } });
    expect(await readOpenBuy()).toBeNull();
    await localExtStorage.set(
      'openBuy' as never,
      { encrypted: { nonce: 'x', cipherText: 'y' } } as never,
    );
    await expect(readOpenBuy()).resolves.toBeNull();
  });

  it('forgets on null', async () => {
    await unlock();
    await writeOpenBuy(paying());
    await writeOpenBuy(null);
    expect(await chrome.storage.local.get('openBuy')).toEqual({});
  });
});
