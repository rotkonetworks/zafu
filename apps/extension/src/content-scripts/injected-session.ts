import { PenumbraRequestFailure } from '@penumbra-zone/client/error';
import { CRSessionClient } from '@penumbra-zone/transport-chrome/session-client';
import { isZignerConnection } from './message/zigner-connection';
import { isZignerControl, ZignerControl } from './message/zigner-control';
import { ZignerMessageEvent, unwrapZignerMessageEvent } from './message/zigner-message-event';
import { listenBackground, sendBackground } from './message/send-background';
import { listenWindow, sendWindow } from './message/send-window';

const zignerDocumentListener = (ev: ZignerMessageEvent): void => {
  const request = unwrapZignerMessageEvent(ev);
  if (isZignerConnection(request)) {
    ev.stopImmediatePropagation();
    void sendBackground(request).then(response => {
      if (response != null) {
        sendWindow<PenumbraRequestFailure>(response);
      }
    });
  }
};

const zignerExtensionListener = (message: unknown, responder: (response: null) => void): boolean => {
  if (!isZignerControl(message)) {
    return false;
  }

  switch (message) {
    case ZignerControl.Init:
      sendWindow<MessagePort>(CRSessionClient.init(ZIGNER));
      break;
    case ZignerControl.End:
      CRSessionClient.end(ZIGNER);
      sendWindow<ZignerControl>(ZignerControl.End);
      break;
    case ZignerControl.Preconnect:
      sendWindow<ZignerControl>(ZignerControl.Preconnect);
      break;
  }
  responder(null);

  return true;
};

listenWindow(undefined, zignerDocumentListener);
listenBackground<null>(undefined, zignerExtensionListener);
