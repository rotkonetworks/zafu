// Must be the first import: see install-console-quieting.ts.
import '../install-console-quieting';
import { PenumbraRequestFailure } from '@penumbra-zone/client/error';
import { CRSessionClient } from '@penumbra-zone/transport-chrome/session-client';
import { onContextInvalidated } from '../utils/reload-notice';
import { isZafuConnection } from './message/zafu-connection';
import { isZafuControl, ZafuControl } from './message/zafu-control';
import { ZafuMessageEvent, unwrapZafuMessageEvent } from './message/zafu-message-event';
import { listenBackground, sendBackground } from './message/send-background';
import { listenWindow, sendWindow } from './message/send-window';

// Bridge our extension id to the MAIN-world content script
// (injected-penumbra-global.ts), which has no chrome.runtime access.
// Manifest order has this ISOLATED script ahead of the MAIN one, so the
// dataset attribute is always set before MAIN reads it.
//
// A plain attribute, not `dataset`: `dataset` is defined on HTMLElement and
// SVGElement only, so on a non-HTML document (a top-level .xml/.svg response,
// or a viewer page served as XML) `documentElement.dataset` is undefined and
// writing it throws an uncaught TypeError that kills this script. setAttribute
// is on Element and works in every document type.
//
// `chrome.runtime.id` returns the literal string 'invalid' for orphaned
// content scripts (i.e. when the extension was reloaded or upgraded
// while this tab was already open). Don't bridge that — the MAIN script
// would otherwise inject `chrome-extension://invalid/manifest.json`
// into window[PenumbraSymbol], which fails and breaks the page's
// wallet picker. Bail silently; the user will get a fresh injection
// next time they navigate.
const ID_ATTRIBUTE = 'data-zafu-extension-id';
const runtimeId = chrome.runtime.id;
if (runtimeId && runtimeId !== 'invalid') {
  document.documentElement?.setAttribute(ID_ATTRIBUTE, runtimeId);
}

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

// Set while the page holds a session port (from ZafuControl.Init until
// ZafuControl.End). `CRSessionClient.end` throws on a manager id it never
// serviced, so the pagehide teardown below must only fire for a session this
// bridge actually opened.
let sessionManagerId: string | undefined;

const zafuExtensionListener = (message: unknown, responder: (response: null) => void): boolean => {
  if (!isZafuControl(message)) {
    return false;
  }

  const extensionId = chrome.runtime.id;
  switch (message) {
    case ZafuControl.Init:
      sessionManagerId = extensionId;
      sendWindow<MessagePort>(CRSessionClient.init(extensionId));
      break;
    case ZafuControl.End:
      sessionManagerId = undefined;
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

// Once the extension context is gone (reload/auto-update under this tab), the
// page can no longer reach us: every `sendBackground` throws
// "Extension context invalidated". Drop our window listener so the page stops
// being answered with a rejection per poke, and let the shared reload notice
// tell the user what to do - the page's provider entry stays inert until then.
const teardown = new AbortController();
onContextInvalidated(() => teardown.abort());

// Chromium reports an unchecked runtime.lastError when a page that still holds
// an extension port enters the back/forward cache ("the page keeping the
// extension port is moved into back/forward cache, so the message channel is
// closed"). A dapp page that navigates away never sends ZafuControl.End, so the
// port we opened for it would outlive the navigation, and a running
// block-processor stream would stay attached to a frozen document. A page that
// leaves has no session to keep, so release it here; a page restored from the
// cache re-connects through the transport's own on-demand reconnect.
window.addEventListener(
  'pagehide',
  () => {
    if (!sessionManagerId) {
      return;
    }
    const managerId = sessionManagerId;
    sessionManagerId = undefined;
    CRSessionClient.end(managerId);
  },
  { signal: teardown.signal },
);

listenWindow(teardown.signal, zafuDocumentListener);
listenBackground<null>(teardown.signal, zafuExtensionListener);
