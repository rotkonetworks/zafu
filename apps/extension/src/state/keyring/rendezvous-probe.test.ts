import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasRendezvous } from './rendezvous-client';
import { EgressBlockedError } from '../../net/egress';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hasRendezvous', () => {
  it('offers the room code while the relay is simply not allowed yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.reject(
          new EgressBlockedError({
            allow: false,
            host: 'relay.zafu.pro',
            reason: 'default-off',
          } as never),
        ),
      ),
    );
    await expect(hasRendezvous('https://relay.zafu.pro')).resolves.toBe(true);
  });

  it('falls back to manual keys when the relay really has no rendezvous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 }))),
    );
    await expect(hasRendezvous('https://frostd.example')).resolves.toBe(false);
  });

  it('falls back to manual keys when the relay cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(hasRendezvous('https://frostd.example')).resolves.toBe(false);
  });
});
