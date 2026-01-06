import { ZignerConnection } from '../../content-scripts/message/zigner-connection';
import { ZignerControl } from '../../content-scripts/message/zigner-control';
import { alreadyApprovedSender } from '../../senders/approve';
import {
  isPrerenderingExternalSender,
  isValidExternalSender,
  PrerenderingExternalSender,
  ValidExternalSender,
} from '../../senders/external';
import { sendTab } from '../send/tab';

// listen for page init
export const contentScriptLoadListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  // responds with null
  respond: (r: null) => void,
): boolean => {
  if (req !== ZignerConnection.Load) {
    return false;
  }

  if (!isValidExternalSender(sender) && !isPrerenderingExternalSender(sender)) {
    return false;
  }

  void handle(sender).then(respond);
  return true;
};

const handle = (sender: ValidExternalSender | PrerenderingExternalSender) =>
  alreadyApprovedSender(sender).then(hasApproval => {
    if (hasApproval) {
      // preconnect only the specific document
      void sendTab(sender, ZignerControl.Preconnect);
    }

    // handler is done
    return null;
  });
