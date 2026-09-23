/**
 * Utilities for detecting popup context and opening extension pages.
 *
 * Browser extensions have two main contexts:
 * 1. Popup - small window opened from toolbar, CANNOT request camera permission
 * 2. Page/Tab - full browser tab, CAN request camera permission
 *
 * For features requiring camera (QR scanning), we need to detect the context
 * and redirect to a full page when necessary.
 */

/**
 * Check if we're in a dedicated window (standalone popup window, not extension popup).
 * Dedicated windows are opened via chrome.windows.create() and won't close on focus loss.
 */
export function isDedicatedWindow(): boolean {
  // A dedicated window loads popup.html (like the toolbar popup) but is NOT
  // among getViews({type:'popup'}) - that API returns only the toolbar popup.
  // Both signals are exact facts: the document identity and the view registry.
  if (typeof chrome !== 'undefined' && chrome.extension?.getViews) {
    try {
      const isToolbarPopup = chrome.extension.getViews({ type: 'popup' }).some(v => v === window);
      return window.location.pathname.endsWith('popup.html') && !isToolbarPopup;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check if we're running in a Chrome side panel.
 * Side panels don't close on focus loss, so we can navigate normally.
 */
export function isSidePanel(): boolean {
  // The side panel loads a DISTINCT document - sidepanel.html (the manifest's
  // side_panel.default_path) - so the pathname is an exact, reliable signal.
  // This is the same approach Keplr uses (pathname === '/sidePanel.html'). No
  // window-size heuristic: the old `innerHeight > 700` fallback misfired both
  // ways - a short side panel read as a popup (so approvals closed it with
  // window.close instead of returning to the wallet home), and a tall popup
  // read as a panel. The document identity is the truth; measuring the window
  // is not.
  return window.location.pathname.endsWith('sidepanel.html');
}

/**
 * Check if the current window is a popup.
 * Popups cannot request camera permissions - the permission dialog won't appear.
 */
export function isPopup(): boolean {
  // The toolbar popup is the one context that cannot prompt for camera/USB, so
  // callers redirect to a tab when this is true. getViews({type:'popup'}) is the
  // authoritative signal: our window is the toolbar popup iff it is among those
  // views. No window-size guess - a 400x600 tab and a large popup both fooled
  // the old `innerWidth < 500 && innerHeight < 700` heuristic. A dedicated
  // window loads popup.html but is NOT in getViews, so it correctly reads false
  // (it can prompt for camera/USB).
  if (typeof chrome !== 'undefined' && chrome.extension?.getViews) {
    try {
      return chrome.extension.getViews({ type: 'popup' }).some(v => v === window);
    } catch {
      // fall through to the document-identity fallback
    }
  }
  // Fallback only when getViews is unavailable: the popup document (not a tab or
  // side panel). No dimensions involved.
  return window.location.pathname.endsWith('popup.html');
}

/**
 * Open the extension's page.html as a new tab.
 * This is needed for features requiring camera permission.
 *
 * @param path - The path within page.html (e.g., '/welcome/import-zigner')
 * @param closeCurrent - Whether to close the current popup window (default: false)
 */
export async function openPageInTab(path: string, closeCurrent = false): Promise<void> {
  const pageUrl = chrome.runtime.getURL(`/page.html#${path}`);

  await chrome.tabs.create({ url: pageUrl });

  if (closeCurrent && isPopup()) {
    window.close();
  }
}

/**
 * Check if camera permission is currently granted.
 * Works across browsers with fallbacks.
 */
export async function checkCameraPermission(): Promise<boolean> {
  try {
    // Try the Permissions API first
    const permission = await navigator.permissions.query({
      name: 'camera' as PermissionName,
    });
    return permission.state === 'granted';
  } catch {
    // Firefox doesn't support querying camera permission
    // Fall back to checking if video devices have labels (only available when permitted)
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some(d => d.kind === 'videoinput' && d.label !== '');
    } catch {
      return false;
    }
  }
}

/**
 * Request camera permission by calling getUserMedia.
 * This will show the browser's permission prompt if not already granted/denied.
 *
 * IMPORTANT: This only works in full page context, not in extension popups!
 */
export async function requestCameraPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    // Stop the stream immediately - we just needed to trigger the prompt
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch (error) {
    console.error('Camera permission denied:', error);
    return false;
  }
}
