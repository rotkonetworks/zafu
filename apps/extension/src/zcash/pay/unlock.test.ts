import { beforeEach, describe, expect, it } from 'vitest';
import { openPayUnlock, stopViaFresh, takePayUnlock } from './via-fresh';

const sessionMock = (chrome.storage.session as unknown as { mock: Map<string, unknown> }).mock;
const NOW = 1_800_000_000_000;

describe('each payment its own unlock', () => {
  beforeEach(() => sessionMock.clear());

  it('a swap and a tex payment running together never take or end each other', async () => {
    await openPayUnlock('swap', undefined, 2, NOW);
    await openPayUnlock('tex', undefined, 2, NOW);
    expect(await takePayUnlock('swap', NOW)).toBe(true);
    expect(await takePayUnlock('tex', NOW)).toBe(true);
    expect(await takePayUnlock('tex', NOW)).toBe(true);
    // tex spent both legs; the swap still has its second
    expect(await takePayUnlock('tex', NOW)).toBe(false);
    stopViaFresh('tex');
    await new Promise(r => setTimeout(r, 0));
    expect(await takePayUnlock('swap', NOW)).toBe(true);
  });

  it('the last one closed leaves no key, and an older flat value reads as none', async () => {
    await openPayUnlock('swap', undefined, 1, NOW);
    stopViaFresh('swap');
    await new Promise(r => setTimeout(r, 0));
    expect(await chrome.storage.session.get('swapUnlock')).toEqual({});
    await chrome.storage.session.set({ swapUnlock: { id: 'old', until: NOW + 1000, legs: 2 } });
    expect(await takePayUnlock('old', NOW)).toBe(false);
  });
});
