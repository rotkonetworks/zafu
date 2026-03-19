import { PenumbraRequestFailure } from '@penumbra-zone/client/error';
import { CRSessionClient } from '@penumbra-zone/transport-chrome/session-client';
import { isZafuConnection } from './message/zafu-connection';
import { isZafuControl, ZafuControl } from './message/zafu-control';
import { ZafuMessageEvent, unwrapZafuMessageEvent } from './message/zafu-message-event';
import { listenBackground, sendBackground } from './message/send-background';
import { listenWindow, sendWindow } from './message/send-window';

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

  // ZAFU is replaced at build time with the extension ID string
  const extensionId = ZAFU;
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
