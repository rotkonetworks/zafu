/**
 * This file is injected by the extension as a content script, to create the
 * mainworld global that allows pages to detect installed providers and connect
 * to them.
 *
 * The global is identified by `Symbol.for('penumbra')` and consists of a record
 * with string keys referring to `PenumbraProvider` objects that contain a
 * simple API. The identifiers on this record should be unique, and correspond
 * to a browser extension id. Providers should provide a link to their extension
 * manifest in their record entry.
 *
 * The global is frozen to discourage mutation, but you should consider that the
 * global and everything on it is only as trustable as the scripts running on
 * the page. Imports, requires, includes, script tags, packages your webapp
 * depends on, userscripts, or other extensions' content scripts could all
 * mutate or preempt this, and all have the power to interfere or intercept
 * connections.
 */

import '@penumbra-zone/client/global';

import { PenumbraRequestFailure } from '@penumbra-zone/client/error';
import { createPenumbraStateEvent } from '@penumbra-zone/client/event';
import type { PenumbraProvider } from '@penumbra-zone/client/provider';
import { PenumbraState } from '@penumbra-zone/client/state';
import { PenumbraSymbol } from '@penumbra-zone/client/symbol';
import { ZafuConnection } from './message/zafu-connection';
import { ZafuControl } from './message/zafu-control';
import { ZafuMessageEvent, unwrapZafuMessageEvent } from './message/zafu-message-event';
import { listenWindow, sendWindow } from './message/send-window';

const isPenumbraRequestFailure = (data: unknown): data is PenumbraRequestFailure =>
  typeof data === 'string' && data in PenumbraRequestFailure;

const prerenderComplete = new Promise<void>(resolve =>
  document.prerendering
    ? document.addEventListener('prerenderingchange', () => resolve(), { once: true })
    : resolve(),
);

// MAIN-world has no chrome.runtime; the ISOLATED-world content script
// (injected-session.ts, listed first in the manifest) writes our extension
// id to a DOM dataset attribute before this script runs. Reading it here
// keeps the build agnostic to the install method (unpacked vs Web Store).
//
// We also reject the literal 'invalid' Chrome returns from
// chrome.runtime.id when the script is orphaned (extension reloaded
// in another tab). Without this guard, an orphaned ISOLATED script
// would bridge 'invalid' through and we'd inject
// chrome-extension://invalid/manifest.json into PenumbraSymbol.
const extensionId = document.documentElement.dataset['zafuExtensionId'] ?? '';
const extensionOrigin =
  extensionId && extensionId !== 'invalid'
    ? `chrome-extension://${extensionId}`
    : '';

// bail if the bridge wasn't populated — page reloaded with no zafu, we
// raced the ISOLATED script (shouldn't happen given manifest order),
// or the ISOLATED script saw an orphaned chrome.runtime.id.
if (!extensionOrigin) {
  // eslint-disable-next-line no-console
  console.debug('[zafu] skipping penumbra provider injection: extension origin unavailable');
} else {

class ZafuInjection {
  private static singleton?: ZafuInjection = new ZafuInjection();

  public static get penumbra() {
    return new ZafuInjection().injection;
  }

  private presentState: PenumbraState = PenumbraState.Disconnected;
  private manifestUrl = `${extensionOrigin}/manifest.json`;
  private stateEvents = new EventTarget();

  private readonly injection: Readonly<PenumbraProvider> = Object.freeze({
    connect: () => this.postConnectRequest(),
    disconnect: () => this.postDisconnectRequest(),
    isConnected: () => this.presentState === PenumbraState.Connected,
    state: () => this.presentState,
    manifest: String(this.manifestUrl),
    addEventListener: this.stateEvents.addEventListener.bind(this.stateEvents),
    removeEventListener: this.stateEvents.removeEventListener.bind(this.stateEvents),
  });

  private constructor() {
    if (ZafuInjection.singleton) {
      return ZafuInjection.singleton;
    }

    // ambient end listener
    const ambientEndListener = (ev: ZafuMessageEvent): void => {
      const content = unwrapZafuMessageEvent(ev);
      if (content === ZafuControl.End) {
        this.setState(PenumbraState.Disconnected);
      }
    };
    listenWindow(undefined, ambientEndListener);

    const listenAc = new AbortController();
    const preconnectListener = (ev: ZafuMessageEvent): void => {
      const content = unwrapZafuMessageEvent(ev);
      if (content !== ZafuConnection.Load) {
        // anything other than our own announcement will remove the listener
        listenAc.abort();

        if (content === ZafuControl.Preconnect) {
          ev.stopImmediatePropagation();
          this.setState(PenumbraState.Connected);
        } else if (globalThis.__DEV__) {
          console.debug('Preconnect cancelled', { content, ev });
        }
      }
    };
    listenWindow(listenAc.signal, preconnectListener);

    // announce load (does not need to wait for prerendering)
    sendWindow<ZafuConnection>(ZafuConnection.Load);
  }

  private setState(state: PenumbraState) {
    if (this.presentState !== state) {
      this.presentState = state;
      this.stateEvents.dispatchEvent(createPenumbraStateEvent(extensionOrigin, this.presentState));
    }
  }

  private postConnectRequest() {
    if (this.presentState !== PenumbraState.Connected) {
      this.setState(PenumbraState.Pending);
    }
    const attempt = this.listenPortMessage();
    void prerenderComplete.then(() => sendWindow<ZafuConnection>(ZafuConnection.Connect));
    return attempt;
  }

  private postDisconnectRequest() {
    const attempt = this.listenEndMessage();
    void prerenderComplete.then(() => sendWindow<ZafuConnection>(ZafuConnection.Disconnect));
    return attempt;
  }

  private listenPortMessage() {
    const connection = Promise.withResolvers<MessagePort>();

    const listenAc = new AbortController();
    const portListener = (ev: ZafuMessageEvent): void => {
      const content = unwrapZafuMessageEvent(ev);
      if (content instanceof MessagePort) {
        ev.stopImmediatePropagation();
        connection.resolve(content);
      } else if (isPenumbraRequestFailure(content)) {
        ev.stopImmediatePropagation();
        connection.reject(new Error('Connection request failed', { cause: content }));
      }
    };
    listenWindow(listenAc.signal, portListener);

    void connection.promise
      .then(() => this.setState(PenumbraState.Connected))
      .catch(() => this.setState(PenumbraState.Disconnected))
      .finally(() => listenAc.abort());

    return connection.promise;
  }

  private listenEndMessage() {
    const disconnection = Promise.withResolvers<void>();

    const listenAc = new AbortController();
    const endListener = (ev: ZafuMessageEvent): void => {
      const content = unwrapZafuMessageEvent(ev);
      if (content === ZafuControl.End) {
        ev.stopImmediatePropagation();
        disconnection.resolve();
      } else if (isPenumbraRequestFailure(content)) {
        ev.stopImmediatePropagation();
        disconnection.reject(new Error('Disconnect request failed', { cause: content }));
      }
    };
    listenWindow(listenAc.signal, endListener);

    void disconnection.promise.finally(() => {
      this.setState(PenumbraState.Disconnected);
      listenAc.abort();
    });

    return disconnection.promise;
  }
}

// inject zafu
Object.defineProperty(
  window[PenumbraSymbol] ??
    // create the global if not present
    Object.defineProperty(window, PenumbraSymbol, { value: {}, writable: false })[PenumbraSymbol],
  extensionOrigin,
  {
    value: ZafuInjection.penumbra,
    writable: false,
    enumerable: true,
  },
);

} // end extensionOrigin guard
