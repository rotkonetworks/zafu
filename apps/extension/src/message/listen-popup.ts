import { Code, ConnectError } from '@connectrpc/connect';
import { errorToJson } from '@connectrpc/connect/protocol-connect';
import { PopupType, PopupRequest, PopupResponse, PopupError, isPopupRequest } from './popup';
import { isValidInternalSender } from '../senders/internal';
import { isSidePanel } from '../utils/popup-detection';

export const listenPopup =
  (
    popupId: string,
    handle: <T extends PopupType>(message: PopupRequest<T>) => Promise<PopupResponse<T>>,
  ) =>
  (
    message: unknown,
    sender: chrome.runtime.MessageSender,

    sendResponse: (response: PopupResponse<any> | PopupError) => void,
  ): boolean => {
    if (!isValidInternalSender(sender) || !isPopupRequest(popupId, message)) {
      return false;
    }

    // Auto-close the approval surface when it is dismissed - but ONLY for a
    // dedicated popup window. In the side panel these are wrong: it must persist
    // across tab switches (visibilitychange -> hidden fires when the user
    // changes tab) and it navigates internally (exitApprovalSurface returns it
    // to the wallet home, which fires a 'navigate' event). Either listener would
    // close the whole panel. The panel is dismissed by the user, not by us.
    if (!isSidePanel()) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          window.close();
        }
      });

      window.navigation.addEventListener('navigate', () => window.close());
    }

    void handle(message)
      .catch(e => ({ error: errorToJson(ConnectError.from(e, Code.Internal), undefined) }))
      .then(sendResponse);

    return true;
  };
