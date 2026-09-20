import { ConnectError, Code } from '@connectrpc/connect';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { localExtStorage } from '@repo/storage-chrome/local';
import { PopupPath } from './routes/popup/paths';
import { openApprovalPopup } from './utils/popup-window';
import { isSidePanelOpen } from './side-panel-presence';

const POPUP_BASE = chrome.runtime.getURL('/popup.html');
const SIDE_PANEL_DEFAULT_PATH = 'sidepanel.html';
const LOGIN_POLL_INTERVAL = 500;

/**
 * When the side panel is open (and the user hasn't opted out of it), route the
 * unlock into the panel itself instead of spawning yet another popup window.
 * A locked wallet otherwise popped a separate login WINDOW before every single
 * approval - the reported "penumbra opens way too many popup windows even in
 * side-panel mode". Resolves true once unlocked; false if the panel closed or
 * side-panel mode is off (caller then falls back to the login window).
 */
const loginViaSidePanel = async (): Promise<boolean> => {
  const useSidePanel =
    (await isSidePanelOpen()) && (await localExtStorage.get('approvalsInSidePanel')) !== false;
  if (!useSidePanel) {
    return false;
  }
  await chrome.sidePanel.setOptions({ path: `sidepanel.html#${PopupPath.LOGIN}`, enabled: true });
  return new Promise<boolean>(resolve => {
    const check = async () => {
      if (await sessionExtStorage.get('passwordKey')) {
        // unlocked - return the panel to the wallet home; the approval that
        // triggered this then routes into the same panel.
        await chrome.sidePanel
          .setOptions({ path: SIDE_PANEL_DEFAULT_PATH, enabled: true })
          .catch(() => undefined);
        resolve(true);
        return;
      }
      // panel closed without unlocking -> let the caller fall back to a window.
      if (!(await isSidePanelOpen())) {
        await chrome.sidePanel
          .setOptions({ path: SIDE_PANEL_DEFAULT_PATH, enabled: true })
          .catch(() => undefined);
        resolve(false);
        return;
      }
      setTimeout(() => void check(), LOGIN_POLL_INTERVAL);
    };
    void check();
  });
};

/**
 * Opens a login popup window and waits for the user to log in.
 * Resolves when logged in, rejects if window is closed without logging in.
 */
const spawnLoginPopup = async (): Promise<void> => {
  const loginUrl = new URL(POPUP_BASE);
  loginUrl.hash = PopupPath.LOGIN;

  const win = await openApprovalPopup(loginUrl.href);

  const windowId = win.id!;

  // Wait for login by polling session storage
  return new Promise((resolve, reject) => {
    const checkLogin = async () => {
      // Check if user logged in
      const loggedIn = await sessionExtStorage.get('passwordKey');
      if (loggedIn) {
        // Close login window and resolve
        chrome.windows.remove(windowId).catch(() => {});
        resolve();
        return;
      }

      // Check if window was closed by user
      try {
        await chrome.windows.get(windowId);
        setTimeout(checkLogin, LOGIN_POLL_INTERVAL);
      } catch {
        reject(new ConnectError('Login cancelled', Code.Canceled));
      }
    };
    checkLogin();
  });
};

/**
 * Ensures user is logged in before continuing.
 * If not logged in, opens a login popup and waits for login.
 * Throws if user closes the login window without logging in.
 */
export const throwIfNeedsLogin = async () => {
  const loggedIn = await sessionExtStorage.get('passwordKey');
  if (loggedIn) {
    return;
  }
  // Prefer unlocking inside an open side panel; only spawn a login window when
  // the panel isn't available (or the user opted out of side-panel approvals).
  if (await loginViaSidePanel()) {
    return;
  }
  await spawnLoginPopup();
};
