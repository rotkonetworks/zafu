import { NavigateOptions, useLocation, useNavigate } from 'react-router-dom';
import { PagePath } from '../routes/page/paths';
import { PopupPath } from '../routes/popup/paths';
import { POPUP_WINDOW_HEIGHT, POPUP_WINDOW_WIDTH } from './popup-window';
import { isSidePanel } from './popup-detection';

/**
 * How a screen change animates (see styles/view-transitions.css):
 * `tab` crossfades, `push` / `back` crossfade with a slight slide.
 */
export type ScreenTransition = 'push' | 'back' | 'tab';

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Navigate options for an animated screen change via the View Transitions
 * API (react-router's `viewTransition`). Returns no options - a plain, instant
 * navigation - where the API is missing or the user prefers reduced motion.
 * Back (history POP) navigations need no options: the router replays the
 * transition of the push they undo.
 */
export const screenTransition = (
  kind: ScreenTransition,
): Pick<NavigateOptions, 'viewTransition'> => {
  if (
    typeof document === 'undefined' ||
    typeof document.startViewTransition !== 'function' ||
    prefersReducedMotion()
  ) {
    return {};
  }
  // read by the CSS to pick the animation; set before the old screen is captured
  document.documentElement.dataset['navDir'] = kind;
  return { viewTransition: true };
};

// Used to add type-safety to navigating routes
export const useTypesafeNav = <T extends string>() => {
  const navigate = useNavigate();
  return (to: T | number, options?: NavigateOptions): void => {
    if (typeof to === 'number') {
      navigate(to);
    } else {
      navigate(to, options);
    }
  };
};

export const usePageNav = useTypesafeNav<PagePath>;

// popup navigations animate (styles/view-transitions.css, loaded by the popup)
export const usePopupNav = () => {
  const navigate = useNavigate();
  return (to: PopupPath | number, options?: NavigateOptions): void => {
    if (typeof to === 'number') {
      screenTransition(to < 0 ? 'back' : 'push');
      navigate(to);
    } else {
      navigate(to, { ...screenTransition('push'), ...options });
    }
  };
};

/** popup-path navigate function, as returned by `usePopupNav` */
export type PopupNav = (to: PopupPath | number, options?: NavigateOptions) => void;

/**
 * Back navigation that respects where the user actually came from.
 *
 * Hardcoded back targets teleport: drawer → networks → back used to land
 * on /settings (never visited), identity → contacts → back landed on home.
 * History-back fixes the common case; `fallback` covers direct entry - * deep links (`?network=zcash`), dedicated approval windows, and popup
 * re-opens that start the session directly on a sub-screen and so have
 * no in-app history (React Router marks that first entry key 'default').
 */
export const useBackNav = (fallback: PopupPath = PopupPath.INDEX) => {
  const navigate = useNavigate();
  const location = useLocation();
  return (): void => {
    if (location.key !== 'default') {
      screenTransition('back');
      navigate(-1);
    } else {
      navigate(fallback, screenTransition('back'));
    }
  };
};

/**
 * Open a popup path in a dedicated window.
 * Unlike the extension popup, this window won't close when it loses focus.
 * Useful for transaction flows that require approval popups.
 */
export const openInDedicatedWindow = async (
  path: PopupPath,
  options?: { width?: number; height?: number },
): Promise<chrome.windows.Window | undefined> => {
  const { width = POPUP_WINDOW_WIDTH, height = POPUP_WINDOW_HEIGHT } = options ?? {};

  // Use hash routing since the popup uses HashRouter
  const url = chrome.runtime.getURL(`popup.html#${path}`);

  return chrome.windows.create({
    url,
    type: 'popup',
    width,
    height,
    focused: true,
  });
};

/**
 * Open the side panel and navigate to a specific path.
 * Side panels don't close on focus loss - ideal for transaction flows.
 */
export const openInSidePanel = async (path: PopupPath): Promise<void> => {
  try {
    // Store the path to navigate to after side panel opens
    await chrome.storage.local.set({ sidePanelNavigateTo: path });

    // Get current tab and open side panel
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (e) {
    console.error('Failed to open side panel:', e);
  }
};

/**
 * Leave an approval surface once the user has responded.
 *
 * Approval routes are deliverable in three contexts: the toolbar popup and
 * dedicated windows can be closed, but `window.close()` is a no-op in the
 * side panel - the panel stays pinned open on a spent approval screen with
 * no way to dismiss it. There, return to the wallet home instead.
 */
export const exitApprovalSurface = (navigate: PopupNav): void => {
  if (isSidePanel()) {
    navigate(PopupPath.INDEX);
  } else {
    window.close();
  }
};
