import { PenumbraRequestFailure } from '@penumbra-zone/client/error';
import type { ZafuConnection } from './zafu-connection';
import { isContextInvalidated, noteContextInvalidated } from '../../utils/reload-notice';

export const sendBackground = async (
  request: ZafuConnection,
): Promise<null | PenumbraRequestFailure> => {
  try {
    const response = await chrome.runtime.sendMessage<ZafuConnection, unknown>(request);

    switch (response) {
      case undefined:
        // A listener received the request but declined to answer - a policy
        // refusal (e.g. this origin is not one we serve), not a bug. Answer the
        // page the same way we answer a rejection, without logging an error.
        return PenumbraRequestFailure.NotHandled;
      case null:
      case PenumbraRequestFailure.Denied:
      case PenumbraRequestFailure.NeedsLogin:
        return response;
      default:
        throw new TypeError(`Unexpected response to ${request}`, { cause: response });
    }
  } catch (error) {
    const fallback =
      error instanceof TypeError
        ? PenumbraRequestFailure.BadResponse
        : PenumbraRequestFailure.NotHandled;
    // Orphaned content script (extension reloaded/upgraded under an open tab):
    // expected state, not a failure. Mark it once - that tells the user to
    // reload, tears down this page's listeners, and stops any further logging,
    // so a page that keeps poking us cannot produce a console error per poke.
    if (isContextInvalidated(error)) {
      noteContextInvalidated();
      return fallback;
    }
    const isExpected =
      error instanceof Error &&
      /Could not establish connection|Receiving end does not exist/.test(error.message);
    if (!isExpected) {
      console.error(error, { fallback, request, error });
    }
    return fallback;
  }
};

export function listenBackground<R = never>(
  signal: AbortSignal | undefined,
  listener: (content: unknown, responder: (response: R) => void) => boolean,
) {
  const wrappedListener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (response: R) => void,
  ): boolean => {
    // Filter to messages from our own extension. chrome.runtime.id is the
    // canonical runtime value — works for both unpacked and Web Store
    // installs without a build-time constant.
    if (sender.id !== chrome.runtime.id) {
      return false;
    }

    return listener(message, respond);
  };

  chrome.runtime.onMessage.addListener(wrappedListener);

  signal?.addEventListener('abort', () => {
    try {
      chrome.runtime.onMessage.removeListener(wrappedListener);
    } catch {
      // Orphaned context (extension reloaded under this page): the extension
      // APIs throw on use. Nothing to detach - the dead context owns the
      // listener, and this page is being torn down anyway.
    }
  });
}
