import { NavigateOptions, useNavigate } from 'react-router-dom';
import { PagePath } from '../routes/page/paths';
import { PopupPath } from '../routes/popup/paths';

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
export const usePopupNav = useTypesafeNav<PopupPath>;

/**
 * Open a popup path in a dedicated window.
 * Unlike the extension popup, this window won't close when it loses focus.
 * Useful for transaction flows that require approval popups.
 */
export const openInDedicatedWindow = async (
  path: PopupPath,
  options?: { width?: number; height?: number }
): Promise<chrome.windows.Window | undefined> => {
  const { width = 400, height = 600 } = options ?? {};

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
