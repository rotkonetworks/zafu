/**
 * Auto-lock's clock. The last time the person used one of zafu's own pages is
 * kept in chrome.storage.session, so it survives the service worker being
 * evicted between alarm ticks (an in-memory timestamp reset to "now" on every
 * wake, and the wallet never locked). Only zafu's pages write it: session
 * storage is closed to content scripts, and no message from a site or a
 * content script counts as activity.
 */

export const LAST_ACTIVITY_KEY = 'lastActivityMs';

/** how often a page may write the clock while the person keeps using it */
const WRITE_EVERY_MS = 15_000;

let lastWrite = 0;

const record = (now = Date.now()): void => {
  if (now - lastWrite < WRITE_EVERY_MS) {
    return;
  }
  lastWrite = now;
  void chrome.storage.session.set({ [LAST_ACTIVITY_KEY]: now }).catch(() => undefined);
};

/** call once from a zafu page: opening it, pointer and key input are activity */
export const trackActivity = (): void => {
  record();
  for (const type of ['pointerdown', 'keydown', 'wheel'] as const) {
    window.addEventListener(type, () => record(), { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      record();
    }
  });
};

/**
 * Has the wallet been idle for `minutes`? With no clock yet (session storage
 * cleared, or the first tick after an update) the clock starts now instead of
 * locking at once.
 */
export const idleFor = async (minutes: number, now = Date.now()): Promise<boolean> => {
  const stored = (await chrome.storage.session.get(LAST_ACTIVITY_KEY))[LAST_ACTIVITY_KEY];
  if (typeof stored !== 'number') {
    await chrome.storage.session.set({ [LAST_ACTIVITY_KEY]: now });
    return false;
  }
  return now - stored >= minutes * 60_000;
};
