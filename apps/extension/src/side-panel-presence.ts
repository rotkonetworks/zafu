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

/** Service-worker side. True if at least one side panel is open right now. */
export const isSidePanelOpen = (): boolean => openCount > 0;

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
