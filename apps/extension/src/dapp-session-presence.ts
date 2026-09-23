/**
 * Tracks how many EXTERNAL (dapp) penumbra transport sessions are live right
 * now. Used to relax the active-network privacy gate in wallet-services: a
 * penumbra dapp (e.g. Veil) that is connected and open needs penumbra services
 * even when the extension's own UI is viewing another network. Without this, the
 * gate stubs penumbra whenever `activeNetwork` is not penumbra-rooted and every
 * dapp view call fails with "penumbra network not active".
 *
 * `validateSessionPort` calls `trackDappSession` for each approved external
 * session port; the port's disconnect decrements the count. The service worker
 * registers hooks so it can (re)start or stop penumbra sync on the first/last
 * session transition - but only when it would actually change the gate outcome
 * (see the hook in service-worker.ts).
 */

let liveSessions = 0;

interface SessionHooks {
  /** fired when the count goes 0 -> 1 (a dapp connected). */
  onFirst?: () => void;
  /** fired when the count goes 1 -> 0 (the last dapp disconnected). */
  onLast?: () => void;
}

let hooks: SessionHooks = {};

/** Service-worker side. Register transition hooks. Call once at startup. */
export const setDappSessionHooks = (next: SessionHooks): void => {
  hooks = next;
};

/**
 * Note a live external session and wire its teardown. Safe to call once per
 * validated external port; the disconnect listener decrements on close.
 */
export const trackDappSession = (port: chrome.runtime.Port): void => {
  liveSessions += 1;
  if (liveSessions === 1) {
    hooks.onFirst?.();
  }
  port.onDisconnect.addListener(() => {
    liveSessions = Math.max(0, liveSessions - 1);
    if (liveSessions === 0) {
      hooks.onLast?.();
    }
  });
};

/** True while at least one external penumbra dapp session is connected. */
export const hasLiveDappSession = (): boolean => liveSessions > 0;
