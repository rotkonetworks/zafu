/**
 * Quiet transient network failures in a worker/global scope.
 *
 * A `fetch()` to an unreachable or not-yet-deployed endpoint rejects with
 * `TypeError: Failed to fetch`; an aborted/timed-out one rejects with an
 * `AbortError`. When such a rejection is not awaited (best-effort background
 * calls, optional services, offline endpoints) it surfaces as a scary
 * "Uncaught (in promise)" in the console - even though the wallet already
 * handles the degraded state fine.
 *
 * This installs a global `unhandledrejection` handler that DOWNGRADES only
 * those network errors to a quiet `console.debug` and suppresses the uncaught
 * spam via `preventDefault()`. Every other rejection is left completely
 * untouched, so genuine bugs still surface loudly. Scope it narrowly on
 * purpose - a catch-all that swallows everything would hide real problems.
 */

const isTransientNetworkError = (reason: unknown): boolean => {
  if (reason instanceof TypeError) {
    const m = reason.message || '';
    // Chromium: "Failed to fetch"; Firefox: "NetworkError when attempting to
    // fetch resource"; Safari: "Load failed".
    return (
      m.includes('Failed to fetch') ||
      m.includes('NetworkError') ||
      m.includes('Load failed')
    );
  }
  // fetch(..., { signal: AbortSignal.timeout(...) }) rejects with AbortError.
  if (reason instanceof DOMException && reason.name === 'AbortError') {
    return true;
  }
  return false;
};

interface RejectionEventLike {
  reason: unknown;
  preventDefault: () => void;
}

/**
 * Install the handler on the current global scope (service worker `self`, a
 * dedicated worker, or a page). Call once at startup, as early as possible.
 */
export const installGracefulNetworkErrorHandler = (): void => {
  const scope = globalThis as unknown as {
    addEventListener?: (type: 'unhandledrejection', cb: (e: RejectionEventLike) => void) => void;
  };
  scope.addEventListener?.('unhandledrejection', (event: RejectionEventLike) => {
    if (isTransientNetworkError(event.reason)) {
      const detail =
        event.reason instanceof Error ? event.reason.message : String(event.reason);
      // Quiet, not an error - the caller already degraded gracefully.
      console.debug('[net] transient fetch failure (offline/unreachable), ignored:', detail);
      event.preventDefault();
    }
  });
};
