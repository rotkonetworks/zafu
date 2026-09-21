import { useEffect } from 'react';
import { usePopupNav } from '../utils/navigate';
import type { PopupPath } from '../routes/popup/paths';
import { isSidePanel } from '../utils/popup-detection';
import { isValidInternalSender } from '../senders/internal';
import { isSidePanelDeliver } from '../message/side-panel-delivery';
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
      if (!isValidInternalSender(sender) || !isSidePanelDeliver(msg)) {
        return false;
      }
      // Listener BEFORE navigate/ready (wirePopupDelivery pings ready): the
      // worker sends the request the moment it sees ready, so the request
      // listener must already be attached.
      wirePopupDelivery(msg.popupId);
      navigate(msg.route as PopupPath);
      respond(true);
      return true;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [navigate]);
};
