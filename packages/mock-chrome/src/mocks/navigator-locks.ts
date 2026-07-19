/**
 * Minimal in-process Web Locks stub for tests.
 *
 * The `navigator.locks` npm polyfill coordinates cross-tab via
 * `localStorage` + storage events. Under vitest it picks up node's global
 * `localStorage` (non-functional without --localstorage-file, and shared
 * state otherwise), so lock requests hang forever and tests time out.
 * Tests only need same-process exclusivity, which a promise queue per lock
 * name provides.
 */

type LockGrantedCallback = (lock: { name: string; mode: 'exclusive' | 'shared' } | null) => unknown;

const queues = new Map<string, Promise<unknown>>();

export const mockLocks: Pick<LockManager, 'request'> = {
  request: (async (
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback,
    maybeCallback?: LockGrantedCallback,
  ) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) {
      throw new TypeError('navigator.locks.request requires a callback');
    }
    const previous = queues.get(name) ?? Promise.resolve();
    const next = previous.then(() => callback({ name, mode: 'exclusive' }));
    queues.set(
      name,
      next.catch(() => undefined),
    );
    return next;
  }) as LockManager['request'],
};

/** Installs the stub as `navigator.locks`. */
export const installMockLocks = () => {
  Object.defineProperty(globalThis.navigator, 'locks', { value: mockLocks, configurable: true });
};
