import { useEffect } from 'react';
import { usePopupNav } from '../utils/navigate';
import type { PopupPath } from '../routes/popup/paths';
import { isSidePanel } from '../utils/popup-detection';
import { isValidInternalSender } from '../senders/internal';
import { isSidePanelDeliver, isSidePanelNavigate } from '../message/side-panel-delivery';
import { wirePopupDelivery } from './popup-ready';

/**
 * Panel-side half of client-side approval delivery.
 *
 * When the worker asks THIS side panel to show an approval (SIDE_PANEL_DELIVER),
 * wire the request listener for its id and navigate the router to the approval
 * route - a client-side route change, no document reload (contrast the
 * detached-window path in usePopupReady, which reads the id from the URL because
 * the window was freshly loaded at it). Returning to the wallet afterward is the
 * approval screen's job via exitApprovalSurface, so nothing here needs undoing.
 *
 * No-op outside the side panel: the worker broadcasts to every extension
 * context, and the detached window handles its own delivery via the URL.
 */
export const useSidePanelDelivery = (): void => {
  const navigate = usePopupNav();

  useEffect(() => {
    if (!isSidePanel()) {
      return;
    }
    const onMessage = (
      msg: unknown,
      sender: chrome.runtime.MessageSender,
      respond: (response: unknown) => void,
    ): boolean => {
      if (!isValidInternalSender(sender)) {
        return false;
      }
      // Approval: wire the request listener BEFORE navigate (wirePopupDelivery
      // pings ready, and the worker sends the request the instant it sees ready,
      // so the listener must already be attached), then navigate to it.
      if (isSidePanelDeliver(msg)) {
        wirePopupDelivery(msg.popupId);
        navigate(msg.route as PopupPath);
        respond(true);
        return true;
      }
      // Unlock: no request to wire, just show the login screen; the worker polls
      // the session key. The following approval delivery navigates away from it.
      if (isSidePanelNavigate(msg)) {
        navigate(msg.route as PopupPath);
        respond(true);
        return true;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [navigate]);
};
