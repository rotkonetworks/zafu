/**
 * A manual lock drops what the seed unlocked: the zcash worker (keys derived
 * from the phrase, its sync loops) is terminated, not left running behind a
 * locked screen until the browser exits.
 */
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { describe, expect, test, vi } from 'vitest';
import { create } from 'zustand';
import { AllSlices, initializeStore } from '..';

const { stopNetworkWorker } = vi.hoisted(() => ({
  stopNetworkWorker: vi.fn(() => Promise.resolve()),
}));
vi.mock('./network-worker', () => ({ stopNetworkWorker }));

describe('lock', () => {
  test('terminates the seed-derived workers and clears the session key', async () => {
    const useStore = create<AllSlices>()(initializeStore(sessionExtStorage, localExtStorage));
    await sessionExtStorage.set('passwordKey', { _inner: {} } as never);
    useStore.getState().keyRing.lock();
    await vi.waitFor(() => expect(stopNetworkWorker).toHaveBeenCalledWith('zcash'));
    expect(stopNetworkWorker).toHaveBeenCalledWith('penumbra');
    expect(await sessionExtStorage.get('passwordKey')).toBeUndefined();
    expect(useStore.getState().keyRing.status).toBe('locked');
  });
});
