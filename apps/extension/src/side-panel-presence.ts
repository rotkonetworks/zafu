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
    // Query ALL contexts and filter in JS. Two reasons this beats passing
    // `contextTypes`/`windowIds` to getContexts:
    //  - contextType is compared as the STRING 'SIDE_PANEL', so a browser whose
    //    `chrome.runtime.ContextType.SIDE_PANEL` enum member is absent/renamed
    //    can't silently turn the filter into a no-match (which read as "closed"
    //    and sent every approval to a popup).
    //  - windowId scoping is done ONLY when the panel contexts actually carry a
    //    usable windowId. Side-panel ExtensionContexts don't reliably populate
    //    windowId on every Chrome build (it can be -1/absent); passing
    //    windowIds:[id] to the API then excludes the real panel and we wrongly
    //    fall back to a popup even with the panel open (the reported bug). If no
    //    panel carries a usable windowId, treat "a panel is open" as open - a
    //    freshly-delivered approval that lands in a panel in another window just
    //    fails its ready-ack and falls back to a popup, which is the safe path.
    const ctxs = await chrome.runtime.getContexts({});
    const panels = ctxs.filter(c => c.contextType === 'SIDE_PANEL');
    if (panels.length === 0) {
      return false;
    }
    if (windowId == null) {
      return true;
    }
    const scopable = panels.some(c => typeof c.windowId === 'number' && c.windowId >= 0);
    if (!scopable) {
      return true; // windowId not reported on this build - don't over-filter
    }
    return panels.some(c => c.windowId === windowId);
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
