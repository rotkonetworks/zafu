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
 * Check if the current window is a popup.
 * Popups cannot request camera permissions - the permission dialog won't appear.
 */
export function isPopup(): boolean {
  // Check if we're in a small popup window
  // Extension popups are typically 400x600 or smaller
  // Also check the URL - popups use popup.html
  const isSmallWindow = window.innerWidth < 500 && window.innerHeight < 700;
  const isPopupUrl = window.location.pathname.includes('popup');

  // Use chrome API if available for more reliable detection
  if (typeof chrome !== 'undefined' && chrome.extension?.getViews) {
    try {
      const popupViews = chrome.extension.getViews({ type: 'popup' });
      // If we find popup views and our window is among them, we're in a popup
      return popupViews.some(view => view === window);
    } catch {
      // Fallback to URL/size detection
    }
  }

  return isPopupUrl || isSmallWindow;
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
