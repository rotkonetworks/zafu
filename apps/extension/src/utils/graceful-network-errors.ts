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
 *
 * It also handles the one non-transient case worth surfacing: an extension
 * reload/auto-update that orphaned this document mid-flight. Every call then
 * throws "Extension context invalidated" and the wallet is silently dead, so
 * instead of a connect-error storm the user gets a reload notice (see
 * `./reload-notice`).
 */

import { isContextInvalidated, noteContextInvalidated } from './reload-notice';

/** Extension reloaded/updated under a live page: notice once, stop the storm. */
const handleContextLoss = (reason: unknown): boolean => {
  if (!isContextInvalidated(reason)) {
    return false;
  }
  noteContextInvalidated();
  return true;
};

const messageOf = (reason: unknown): string => {
  if (reason instanceof Error) {
    return reason.message || '';
  }
  if (typeof reason === 'string') {
    return reason;
  }
  if (reason && typeof reason === 'object' && 'message' in reason) {
    return String((reason as { message: unknown }).message ?? '');
  }
  return '';
};

// Benign background failures the wallet already handles: a transient fetch, and
// the penumbra transport's expected teardown/inactive noise. When zcash (or any
// non-penumbra network) is active the penumbra services are stubbed, so the
// popup's penumbra clients see their port close - surfacing as ConnectErrors and
// stream-teardown TypeErrors that are NOT bugs. Matched narrowly on purpose so a
// genuine failure still surfaces loudly.
const BENIGN_PATTERNS = [
  'Failed to fetch',
  'NetworkError',
  'Load failed',
  'Could not establish connection',
  'Receiving end does not exist',
  'penumbra network not active',
  'penumbra network not enabled',
  'Sync stop wallet switch',
  'BodyStreamBuffer was aborted',
  'Cannot enqueue a chunk into a closed readable stream',
];

const isBenignBackgroundError = (reason: unknown): boolean => {
  if (reason instanceof DOMException && reason.name === 'AbortError') {
    return true;
  }
  const m = messageOf(reason);
  return !!m && BENIGN_PATTERNS.some(p => m.includes(p));
};

interface RejectionEventLike {
  reason: unknown;
  preventDefault: () => void;
}
interface ErrorEventLike {
  error?: unknown;
  message?: string;
  preventDefault: () => void;
}

/**
 * Install the handler on the current global scope (service worker `self`, a
 * dedicated worker, or a page). Call once at startup, as early as possible.
 *
 * Handles BOTH unhandled promise rejections (best-effort background fetches,
 * penumbra ConnectErrors) and `error` events (values reported via the global
 * `reportError`, e.g. the penumbra session client). Only benign, already-handled
 * failures are quieted; everything else is left untouched.
 */
export const installGracefulNetworkErrorHandler = (): void => {
  const scope = globalThis as unknown as {
    addEventListener?: (
      type: 'unhandledrejection' | 'error',
      cb: (e: RejectionEventLike | ErrorEventLike) => void,
    ) => void;
  };
  scope.addEventListener?.('unhandledrejection', (event: unknown) => {
    const e = event as RejectionEventLike;
    if (handleContextLoss(e.reason)) {
      e.preventDefault();
    } else if (isBenignBackgroundError(e.reason)) {
      console.debug('[net] benign background failure, ignored:', messageOf(e.reason));
      e.preventDefault();
    }
  });
  scope.addEventListener?.('error', (event: unknown) => {
    const e = event as ErrorEventLike;
    const reason = e.error ?? e.message;
    if (handleContextLoss(reason)) {
      e.preventDefault();
    } else if (isBenignBackgroundError(reason)) {
      console.debug('[net] benign reported error, ignored:', messageOf(reason));
      e.preventDefault();
    }
  });
};
