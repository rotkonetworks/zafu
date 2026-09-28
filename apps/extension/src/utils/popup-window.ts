/**
 * Canonical geometry + spawn helper for dedicated extension popup windows
 * (approvals, login, standalone wallet window).
 *
 * Every approval-shaped window must be 420x760 and anchored to the top
 * right of the last-focused browser window. Keeping this in one place
 * prevents the size drift that made approval screens clip their
 * Approve/Deny buttons. Sized generously on purpose - the old 400x628 read
 * as cramped next to the side panel and clipped tx detail on longer approvals.
 */

export const POPUP_WINDOW_WIDTH = 420;
export const POPUP_WINDOW_HEIGHT = 760;

/** 420x760, anchored top-right of the last-focused browser window */
export const popupWindowGeometry = async (): Promise<{
  width: number;
  height: number;
  top: number;
  left: number;
}> => {
  // The anchor is a nicety, the size is the point: a browser that refuses
  // `getLastFocused` (no window yet, an odd window type, a mock) must not take
  // the approval down with it. Fall back to the canonical size at 0,0.
  const focused = await chrome.windows.getLastFocused?.().catch(() => undefined);
  const { top = 0, left = 0, width = 0 } = focused ?? {};
  return {
    width: POPUP_WINDOW_WIDTH,
    height: POPUP_WINDOW_HEIGHT,
    top: Math.max(0, top),
    left: Math.max(0, left + width - POPUP_WINDOW_WIDTH),
  };
};

/**
 * Open a url in a canonical approval-sized popup window.
 *
 * The anchor is a nicety, opening is not. Chrome refuses to create a window
 * less than half inside the visible screen, and the anchor is computed from the
 * browser WINDOW's geometry - which can legitimately sit off-screen (dragged
 * past an edge, display scaling, a window larger than the reported screen, a
 * virtual/multi-monitor layout). Letting that rejection propagate took every
 * approval surface with it: login, connect, sign and the passkey consent screen
 * all silently failed to open, the dapp got no answer for its request, and it
 * fell back to the platform. So retry once with Chrome's own on-screen
 * placement, keeping the sizing (which is what the approval screens need).
 */
export const openApprovalPopup = async (url: string): Promise<chrome.windows.Window> => {
  const geometry = await popupWindowGeometry();
  // focused: true so the approval comes to the front instead of opening behind
  // the browser or on another display, which reads to the user as "nothing
  // opened" and drives a second click into the already-open lock.
  try {
    return await chrome.windows.create({ url, type: 'popup', focused: true, ...geometry });
  } catch {
    const { width, height } = geometry;
    return chrome.windows.create({ url, type: 'popup', focused: true, width, height });
  }
};
