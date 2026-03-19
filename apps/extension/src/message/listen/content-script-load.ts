import { ZafuConnection } from '../../content-scripts/message/zafu-connection';
import { ZafuControl } from '../../content-scripts/message/zafu-control';
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
  if (req !== ZafuConnection.Load) {
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
      void sendTab(sender, ZafuControl.Preconnect);
    }

    // handler is done
    return null;
  });
