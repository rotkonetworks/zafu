import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { beforeEach, describe, expect, test } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore } from '..';
import {
  forgetOpenSwap,
  isStale,
  openSwapOf,
  patchOpenSwap,
  quoteOf,
  readOpenSwaps,
  saveOpenSwap,
  swapCardLines,
} from './open-swaps';
import type { Quote } from './provider';

const localMock = (chrome.storage.local as unknown as { mock: Map<string, unknown> }).mock;
const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;

const VAULT = 'bc1qzclnr35llscdedzrwdmemm70es05ngg904l66z';
const MEMO = '=:ZEC.ZEC:t1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf:2960/1/0';
// now: the store drops a closed unpaid window on every write
const NOW = Date.now();

const quote: Quote = {
  route: 'thor',
  amountOut: 123_456_789n,
  amountOutText: '1.23456',
  amountInText: '0.01',
  atLeastText: '1.2',
  expiresAt: NOW + 900_000,
  depositAddress: VAULT,
  memo: MEMO,
  recipient: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf',
  raw: { big: 'not kept' },
};
const req = {
  direction: 'into_zec' as const,
  token: { symbol: 'BTC', chain: 'btc', decimals: 8, usd: 60_000 },
  amountIn: '0.01',
  otherAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
};
const swapT = { index: 21, address: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf' };

describe('a swap in flight is remembered, sealed', () => {
  beforeEach(async () => {
    localMock.clear();
    sessionMock.clear();
    const useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await useStore.getState().keyRing.setPassword('s0meUs3rP@ssword');
  });

  test('never in the clear, and read back as the quote it was', async () => {
    const o = openSwapOf(quote, req, 'vault#1', 'deposit', swapT, NOW);
    expect(await saveOpenSwap(o)).toBe(true);
    const raw = JSON.stringify(localMock.get('openSwaps'));
    expect(raw).toContain('encrypted');
    expect(raw).not.toContain(VAULT);
    expect(raw).not.toContain('t1PTs8');
    const [back] = await readOpenSwaps();
    expect(back).toEqual(o);
    expect(quoteOf(back!)).toMatchObject({
      route: 'thor',
      amountOut: 123_456_789n,
      depositAddress: VAULT,
      memo: MEMO,
    });
    expect(back!.swapT).toEqual(swapT);
  });

  test('a step patches the one swap; forgetting it leaves no trace', async () => {
    const a = openSwapOf(quote, req, 'vault', 'deposit', undefined, NOW);
    const b = openSwapOf(
      { ...quote, depositAddress: 'bc1qother' },
      req,
      'vault',
      'deposit',
      undefined,
      NOW + 1,
    );
    await saveOpenSwap(a);
    await saveOpenSwap(b);
    await patchOpenSwap(a.id, { stage: 'sent', depositTxid: 'ab'.repeat(32) });
    const list = await readOpenSwaps();
    expect(list.find(s => s.id === a.id)).toMatchObject({
      stage: 'sent',
      depositTxid: 'ab'.repeat(32),
    });
    expect(list.find(s => s.id === b.id)?.stage).toBe('deposit');
    await forgetOpenSwap(a.id);
    await forgetOpenSwap(b.id);
    expect(await readOpenSwaps()).toEqual([]);
    expect(localMock.has('openSwaps')).toBe(false);
  });

  test('locked: reads none and writes nothing, never wiping what is there', async () => {
    await saveOpenSwap(openSwapOf(quote, req, 'vault', 'deposit', undefined, NOW));
    const sealed = localMock.get('openSwaps');
    await chrome.storage.session.remove('passwordKey');
    expect(await readOpenSwaps()).toEqual([]);
    expect(await saveOpenSwap(openSwapOf(quote, req, 'vault', 'sent', undefined, NOW + 5))).toBe(
      false,
    );
    expect(localMock.get('openSwaps')).toEqual(sealed);
  });
});

describe('what home shows', () => {
  const o = openSwapOf(quote, req, 'vault', 'deposit', undefined, NOW);

  test('an unpaid window counts down, then says it closed', () => {
    expect(swapCardLines(o, NOW).status).toBe('pay 0.01 btc · 15:00 left');
    expect(swapCardLines(o, NOW + 900_001).status).toMatch(/window closed/);
  });

  test('an unpaid window goes once it closed; a paid or moved swap never quietly', () => {
    expect(isStale(o, NOW + 900_001)).toBe(true);
    expect(isStale({ ...o, watch: 'deposit' }, NOW + 900_001)).toBe(false);
    expect(isStale({ ...o, stage: 'sent', depositTxid: 'x' }, NOW + 9e9)).toBe(false);
    expect(isStale({ ...o, stage: 'thor-out' }, NOW + 9e9)).toBe(false);
  });
});
