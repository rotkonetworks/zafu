import { describe, expect, it, vi } from 'vitest';
import type { WalletJson } from '@repo/wallet';

const load = async () => {
  vi.resetModules();
  return import('./wallet-cache');
};

const wallet = { id: 'w' } as unknown as WalletJson;

describe('wallet-cache', () => {
  it('a reset while pending does not strand getters already waiting', async () => {
    const cache = await load();
    const waiting = cache.getWalletReady();
    cache.resetWalletCache();
    cache.setCachedWallet(wallet);
    await expect(waiting).resolves.toBe(wallet);
  });

  it('a reset after settling blocks new getters until the next set', async () => {
    const cache = await load();
    cache.setCachedWallet(undefined, 'penumbra network not active');
    await expect(cache.getWalletReady()).rejects.toThrow('penumbra network not active');
    cache.resetWalletCache();
    const next = cache.getWalletReady();
    cache.setCachedWallet(wallet);
    await expect(next).resolves.toBe(wallet);
  });
});

describe('wallet-cache stub after a pending reset', () => {
  it('a reset while pending, then a failed set, rejects waiting getters', async () => {
    const cache = await load();
    const waiting = cache.getWalletReady();
    cache.resetWalletCache();
    cache.setCachedWallet(undefined, 'penumbra network not enabled');
    await expect(waiting).rejects.toThrow('penumbra network not enabled');
  });
});
