/**
 * One Web Lock, shared by every context of the extension (service worker,
 * popup, side panel, offscreen host), between code that uses the password
 * key and a password change that replaces it.
 *
 * Users take it shared: many run at once, and one may nest inside another.
 * The swap takes it exclusive, so it starts only once every user has
 * finished and holds new ones off until the new key is in place - nothing
 * reads a box the swap is moving, or seals one under a key about to go.
 * The swap never queues (ifAvailable, retried), because a queued exclusive
 * request would park a nested shared one behind it and deadlock.
 */

const NAME = 'zafu-keyring';
const SWAP_WAIT_MS = 15_000;

export const keyUse = <T>(fn: () => Promise<T>): Promise<T> =>
  navigator.locks.request(NAME, { mode: 'shared' }, fn) as Promise<T>;

export const keySwap = async <T>(fn: () => Promise<T>): Promise<T> => {
  const until = Date.now() + SWAP_WAIT_MS;
  for (;;) {
    const out: { value: T } | null = await navigator.locks.request(
      NAME,
      { mode: 'exclusive', ifAvailable: true },
      async lock => (lock ? { value: await fn() } : null),
    );
    if (out) {
      return out.value;
    }
    if (Date.now() > until) {
      throw new Error('the keyring stayed busy; nothing was changed');
    }
    await new Promise(r => setTimeout(r, 25));
  }
};
