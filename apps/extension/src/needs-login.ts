import { ConnectError, Code } from '@connectrpc/connect';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { localExtStorage } from '@repo/storage-chrome/local';
import { PopupPath } from './routes/popup/paths';
import { openApprovalPopup } from './utils/popup-window';
import { isSidePanelOpen } from './side-panel-presence';
import { SIDE_PANEL_NAVIGATE } from './message/side-panel-delivery';

const POPUP_BASE = chrome.runtime.getURL('/popup.html');
const LOGIN_POLL_INTERVAL = 500;

/** The browser window the user is actually looking at, or undefined. */
const focusedWindowId = async (): Promise<number | undefined> => {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return w.id;
  } catch {
    return undefined;
  }
};

/**
 * When the side panel is open IN THE WINDOW THE USER IS LOOKING AT (and they
 * haven't opted out of it), route the unlock into the panel itself instead of
 * spawning yet another popup window. A locked wallet otherwise popped a separate
 * login WINDOW before every single approval - the reported "penumbra opens way
 * too many popup windows even in side-panel mode".
 *
 * Presence MUST be scoped to the focused window. getContexts is global, so a
 * panel left open in some other window (or an enabled-but-not-visible one) used
 * to read as "open" - we then showed the login on an invisible panel and polled
 * forever, the reported "login just spins while the sidebar is closed". Scoping
 * means: no visible panel here -> return false immediately so the caller opens a
 * login window; panel closed mid-wait -> same fall-through.
 *
 * Delivery is a client-side navigation (message the open panel to show LOGIN), NOT
 * chrome.sidePanel.setOptions - so the panel is not reloaded and its document path
 * is never changed, matching the approval delivery. Nothing to restore: on unlock
 * the triggering approval navigates the same panel to itself; on fall-through the
 * login window takes over.
 *
 * Resolves true once unlocked; false when there is no visible panel to unlock in.
 */
const loginViaSidePanel = async (): Promise<boolean> => {
  const winId = await focusedWindowId();
  const useSidePanel =
    (await isSidePanelOpen(winId)) && (await localExtStorage.get('approvalsInSidePanel')) !== false;
  if (!useSidePanel) {
    return false;
  }
  chrome.runtime
    .sendMessage({ type: SIDE_PANEL_NAVIGATE, route: PopupPath.LOGIN })
    .catch(() => undefined);
  return new Promise<boolean>(resolve => {
    const check = async () => {
      if (await sessionExtStorage.get('passwordKey')) {
        resolve(true);
        return;
      }
      // panel no longer visible in the user's window (closed, or they switched
      // windows) -> stop waiting and let the caller open a login window.
      if (!(await isSidePanelOpen(winId))) {
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
