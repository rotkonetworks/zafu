/**
 * Tracks whether the side panel is currently open, so approval routing can
 * target it only when it is actually there - rather than guessing from a render
 * timeout, which races when an open panel renders slowly.
 *
 * Both halves run inside this extension: the side-panel document opens a named
 * port on mount; the service worker counts live ports. A connected port also
 * keeps the worker alive while the panel is open, so the count stays accurate.
 */

const PORT_NAME = 'zafu-sidepanel-presence';

let openCount = 0;

/**
 * Service-worker side. Start counting open side-panel documents. Call once at
 * worker startup.
 */
export const trackSidePanelPresence = (): void => {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== PORT_NAME) {
      return;
    }
    openCount += 1;
    port.onDisconnect.addListener(() => {
      openCount = Math.max(0, openCount - 1);
    });
  });
};

/**
 * Service-worker side. True if a side panel is open right now.
 *
 * Queries the browser authoritatively via `chrome.runtime.getContexts` rather
 * than trusting the port counter. The counter (below) had three failure modes
 * that all made approvals wrongly fall back to a detached popup window while the
 * panel was visibly open:
 *   - transient zero: navigating the panel (setOptions/restore) unloads the old
 *     document, dropping its port, so a chained second request checked presence
 *     in the gap before the reloaded doc re-announced;
 *   - service-worker respawn (update/crash) reset the module-level count to 0;
 *   - the isSidePanel() innerHeight heuristic mis-announced (the 420x760 popup
 *     window looked like a panel; a short-display panel looked like neither).
 * The SIDE_PANEL context survives a document navigation and is a real browser
 * fact, so it sidesteps all three. The port counter stays as the fallback for
 * a browser too old for getContexts (Chrome < 116).
 */
export const isSidePanelOpen = async (windowId?: number): Promise<boolean> => {
  try {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.SIDE_PANEL],
      // getContexts is GLOBAL by default: a panel open in another browser window
      // counts as "open" here. When a caller knows which window the user is
      // actually looking at, scope to it - otherwise login routing targets a
      // panel the user cannot see and appears to hang. windowIds is Chrome 116+;
      // an older browser ignores it (falls back to global, the prior behavior).
      ...(windowId != null ? { windowIds: [windowId] } : {}),
    });
    return ctxs.length > 0;
  } catch {
    return openCount > 0;
  }
};

/**
 * Panel-document side. Announce presence for the lifetime of the document; the
 * port disconnects automatically when the panel closes. Only call from a
 * document actually running as the side panel.
 */
export const announceSidePanelPresence = (): void => {
  try {
    chrome.runtime.connect({ name: PORT_NAME });
  } catch {
    // extension context unavailable - nothing to announce
  }
};
