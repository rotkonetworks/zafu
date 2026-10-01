/**
 * Minimal in-process Web Locks stub for tests.
 *
 * The `navigator.locks` npm polyfill coordinates cross-tab via
 * `localStorage` + storage events. Under vitest it picks up node's global
 * `localStorage` (non-functional without --localstorage-file, and shared
 * state otherwise), so lock requests hang forever and tests time out.
 * Tests only need same-process semantics: exclusive and shared modes and
 * `ifAvailable`, granted in request order as the spec does.
 */

type Mode = 'exclusive' | 'shared';
type LockGrantedCallback = (lock: { name: string; mode: Mode } | null) => unknown;

interface Resource {
  held: Mode[];
  queue: { mode: Mode; grant: () => void }[];
}

const resources = new Map<string, Resource>();

const resource = (name: string): Resource => {
  let r = resources.get(name);
  if (!r) {
    r = { held: [], queue: [] };
    resources.set(name, r);
  }
  return r;
};

const grantable = (r: Resource, mode: Mode, ahead: Resource['queue']) =>
  mode === 'exclusive'
    ? r.held.length === 0 && ahead.length === 0
    : !r.held.includes('exclusive') && !ahead.some(q => q.mode === 'exclusive');

const pump = (r: Resource) => {
  while (r.queue.length && grantable(r, r.queue[0]!.mode, [])) {
    const next = r.queue.shift()!;
    r.held.push(next.mode);
    next.grant();
  }
};

export const mockLocks: Pick<LockManager, 'request'> = {
  request: (async (
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback,
    maybeCallback?: LockGrantedCallback,
  ) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    if (!callback) {
      throw new TypeError('navigator.locks.request requires a callback');
    }
    const mode: Mode = options.mode ?? 'exclusive';
    const r = resource(name);
    if (options.ifAvailable && !grantable(r, mode, r.queue)) {
      return callback(null);
    }
    if (grantable(r, mode, r.queue)) {
      r.held.push(mode);
    } else {
      await new Promise<void>(grant => r.queue.push({ mode, grant }));
    }
    try {
      return await callback({ name, mode });
    } finally {
      r.held.splice(r.held.indexOf(mode), 1);
      pump(r);
    }
  }) as LockManager['request'],
};

/** Installs the stub as `navigator.locks`. */
export const installMockLocks = () => {
  Object.defineProperty(globalThis.navigator, 'locks', { value: mockLocks, configurable: true });
};
