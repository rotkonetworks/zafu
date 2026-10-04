/**
 * Tracks whether any zafu UI surface (popup, side panel, or a page/options
 * tab) is open right now, so a background feature that must run only while
 * the user has zafu open - never from an alarm while it is closed - has
 * something to gate on.
 *
 * Same port pattern as side-panel-presence.ts, but counts every UI realm
 * instead of the side panel specifically. A connected port also keeps the
 * service worker alive, so whatever runs on `onFirstOpen` (a setInterval,
 * say) keeps ticking for exactly as long as a surface stays open and dies
 * with it - no separate alarm needed.
 */

const PORT_NAME = 'zafu-ui-open';

let openCount = 0;

/**
 * Service-worker side. Call once at worker startup. `onFirstOpen` fires the
 * moment the first UI surface connects; `onLastClose` when the last one
 * disconnects.
 */
export const trackUiOpenPresence = (onFirstOpen: () => void, onLastClose: () => void): void => {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== PORT_NAME) {
      return;
    }
    openCount += 1;
    if (openCount === 1) {
      onFirstOpen();
    }
    port.onDisconnect.addListener(() => {
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) {
        onLastClose();
      }
    });
  });
};

/** a port that lived this long was a real connection, not a failed connect */
const HEALTHY_MS = 5_000;
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 30_000;
let retryMs = RETRY_MIN_MS;

/**
 * UI side. Announce presence for the lifetime of the document. A service
 * worker that restarts starts counting from zero, so the port reconnects:
 * otherwise another window closing later reads as the last one, and sync
 * stops under a window that is still open.
 *
 * A connect that cannot reach the worker (stopped, updating, failed to start)
 * disconnects at once with "Receiving end does not exist". That error is
 * read here, so Chrome does not print it as an unchecked runtime.lastError,
 * and the next try backs off instead of reconnecting in a tight loop (the
 * popup console once held 203 of them).
 */
export const announceUiOpenPresence = (): void => {
  const opened = Date.now();
  try {
    chrome.runtime.connect({ name: PORT_NAME }).onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      retryMs =
        Date.now() - opened >= HEALTHY_MS ? RETRY_MIN_MS : Math.min(retryMs * 2, RETRY_MAX_MS);
      setTimeout(announceUiOpenPresence, retryMs);
    });
  } catch {
    // extension context unavailable - nothing to announce
  }
};
