import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  let status = 'not-loaded';
  const subs = new Set<() => void>();
  return {
    set: (s: string) => {
      status = s;
      subs.forEach(f => f());
    },
    subs,
    useStore: {
      getState: () => ({ keyRing: { status } }),
      subscribe: (f: () => void) => (subs.add(f), () => subs.delete(f)),
    },
  };
});
vi.mock('.', () => ({ useStore: store.useStore }));

const { keyringLoaded } = await import('./loaded');

describe('keyringLoaded', () => {
  it('waits for the keyring a just-woken worker has not read yet, then lets go of the store', async () => {
    let done = false;
    const waiting = keyringLoaded().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    store.set('locked');
    await waiting;
    expect(done).toBe(true);
    expect(store.subs.size).toBe(0);
  });

  it('answers at once when it is already loaded', async () => {
    store.set('unlocked');
    await keyringLoaded();
    expect(store.subs.size).toBe(0);
  });
});
