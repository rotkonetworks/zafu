/**
 * Canonical geometry + spawn helper for dedicated extension popup windows
 * (approvals, login, standalone wallet window).
 *
 * Every approval-shaped window must be 400x628 and anchored to the top
 * right of the last-focused browser window. Keeping this in one place
 * prevents the size drift that made approval screens clip their
 * Approve/Deny buttons.
 */

export const POPUP_WINDOW_WIDTH = 400;
export const POPUP_WINDOW_HEIGHT = 628;

/** 400x628, anchored top-right of the last-focused browser window */
export const popupWindowGeometry = async (): Promise<{
  width: number;
  height: number;
  top: number;
  left: number;
}> => {
  const { top = 0, left = 0, width = 0 } = await chrome.windows.getLastFocused();
  return {
    width: POPUP_WINDOW_WIDTH,
    height: POPUP_WINDOW_HEIGHT,
    top: Math.max(0, top),
    left: Math.max(0, left + width - POPUP_WINDOW_WIDTH),
  };
};

/** Open a url in a canonical approval-sized popup window */
export const openApprovalPopup = async (url: string): Promise<chrome.windows.Window> => {
  const geometry = await popupWindowGeometry();
  return chrome.windows.create({ url, type: 'popup', ...geometry });
};
