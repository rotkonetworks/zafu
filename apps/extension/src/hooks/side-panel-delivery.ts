import { useEffect, useRef } from 'react';
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
 * Wiring is per popup id and done ONCE: the worker re-sends the delivery every
 * 250ms until its ready ping is acknowledged (deliverToSidePanel), and a busy
 * panel can ack late enough that a second send lands. Wiring twice would attach
 * a second request listener, and the approval slice refuses the duplicate with
 * "Another request is still pending" - an error the worker's sendPopup may then
 * take as the answer to the real request, failing a transaction whose approval
 * is still on screen.
 *
 * The listener is attached ONCE per mount and detached only on unmount.
 * `usePopupNav` returns a new function every render, so with `[navigate]` as
 * the effect's deps the cleanup ran on every render - and the navigate below
 * IS a render. It detached the request listener it had just wired, the
 * worker's request arrived to nobody, and every approval opened as an empty
 * (black) panel that never loaded. navigate is read through a ref instead.
 *
 * No-op outside the side panel: the worker broadcasts to every extension
 * context, and the detached window handles its own delivery via the URL.
 */
export const useSidePanelDelivery = (): void => {
  const navigate = usePopupNav();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const wired = useRef(new Map<string, () => void>());

  useEffect(() => {
    if (!isSidePanel()) {
      return;
    }
    const detachers = wired.current;
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
        if (!detachers.has(msg.popupId)) {
          detachers.set(msg.popupId, wirePopupDelivery(msg.popupId));
        }
        navigateRef.current(msg.route as PopupPath);
        respond(true);
        return true;
      }
      // Unlock: no request to wire, just show the login screen; the worker polls
      // the session key. The following approval delivery navigates away from it.
      if (isSidePanelNavigate(msg)) {
        navigateRef.current(msg.route as PopupPath);
        respond(true);
        return true;
      }
      return false;
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      for (const detach of detachers.values()) {
        detach();
      }
      detachers.clear();
    };
  }, []);
};
