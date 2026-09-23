/**
 * Quiet one specific dev-build log before anything can emit it.
 *
 * `@penumbra-zone/transport-chrome`'s CRSessionClient logs EVERY reported
 * error as `console.warn('session-client reportError', requestId, msg)`,
 * gated on `globalThis.__DEV__` (session-client.js:292-295). Anything that
 * probes the wallet on a loop — cosmos-kit looking for a Keplr provider
 * while keplrCompat is off, a poller treating not-found as an error —
 * turns that into hundreds of identical lines and makes the page console
 * unusable for actual debugging.
 *
 * `installGracefulNetworkErrorHandler` cannot help here: it works by
 * preventDefault()-ing `error`/`unhandledrejection` events, and this is a
 * bare console.warn inside a dependency, with no event to cancel.
 *
 * Scoped as tightly as possible — exact first argument, warn only, dev
 * only — so nothing else is ever swallowed. The underlying errors are
 * untouched; `reportError` still postMessages them to the client, exactly
 * as it does in a production build where this log does not exist at all.
 */
if (globalThis.__DEV__) {
  const nativeWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (args[0] === 'session-client reportError') {
      return;
    }
    nativeWarn(...args);
  };
}

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
//
// `chrome.runtime.id` returns the literal string 'invalid' for orphaned
// content scripts (i.e. when the extension was reloaded or upgraded
// while this tab was already open). Don't bridge that — the MAIN script
// would otherwise inject `chrome-extension://invalid/manifest.json`
// into window[PenumbraSymbol], which fails and breaks the page's
// wallet picker. Bail silently; the user will get a fresh injection
// next time they navigate.
const runtimeId = chrome.runtime.id;
if (runtimeId && runtimeId !== 'invalid') {
  document.documentElement.dataset['zafuExtensionId'] = runtimeId;
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
