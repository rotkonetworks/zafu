import { PenumbraRequestFailure } from '@penumbra-zone/client/error';
import { CRSessionClient } from '@penumbra-zone/transport-chrome/session-client';
import { isZafuConnection } from './message/zafu-connection';
import { isZafuControl, ZafuControl } from './message/zafu-control';
import { ZafuMessageEvent, unwrapZafuMessageEvent } from './message/zafu-message-event';
import { listenBackground, sendBackground } from './message/send-background';
import { listenWindow, sendWindow } from './message/send-window';

// Bridge our extension id to the MAIN-world content script
// (injected-penumbra-global.ts), which has no chrome.runtime access.
// Manifest order has this ISOLATED script ahead of the MAIN one, so the
// dataset attribute is always set before MAIN reads it.
document.documentElement.dataset['zafuExtensionId'] = chrome.runtime.id;

const zafuDocumentListener = (ev: ZafuMessageEvent): void => {
  const request = unwrapZafuMessageEvent(ev);
  if (isZafuConnection(request)) {
    ev.stopImmediatePropagation();
    void sendBackground(request).then(response => {
      if (response != null) {
        sendWindow<PenumbraRequestFailure>(response);
      }
    });
  }
};

const zafuExtensionListener = (message: unknown, responder: (response: null) => void): boolean => {
  if (!isZafuControl(message)) {
    return false;
  }

  const extensionId = chrome.runtime.id;
  switch (message) {
    case ZafuControl.Init:
      sendWindow<MessagePort>(CRSessionClient.init(extensionId));
      break;
    case ZafuControl.End:
      CRSessionClient.end(extensionId);
      sendWindow<ZafuControl>(ZafuControl.End);
      break;
    case ZafuControl.Preconnect:
      sendWindow<ZafuControl>(ZafuControl.Preconnect);
      break;
  }
  responder(null);

  return true;
};

listenWindow(undefined, zafuDocumentListener);
listenBackground<null>(undefined, zafuExtensionListener);
