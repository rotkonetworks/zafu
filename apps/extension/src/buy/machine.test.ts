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

  it('moves on to released when the intent is gone and the usdc is here', () => {
    const b = advance(paying(), 'confirming', {}, T0 + 70_000);
    expect(resume(b, { now: T0 + 80_000, intent: 'gone', usdc: offer.net }).stage).toBe('released');
    // gone without the usdc: returned to the seller
    expect(resume(b, { now: T0 + 80_000, intent: 'gone', usdc: 0n }).stage).toBe('expired');
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
