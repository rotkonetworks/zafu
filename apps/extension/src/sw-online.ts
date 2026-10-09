/**
 * The service worker's `online` listener, registered from a sync module at
 * initial evaluation, as MV3 requires (see ./install-global-error-handlers for
 * why the entry body is too late). Features that start later subscribe here.
 */

const listeners = new Set<() => void>();

// absent outside a worker or a page (node tests)
globalThis.addEventListener?.('online', () => listeners.forEach(l => l()));

export const onOnline = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
