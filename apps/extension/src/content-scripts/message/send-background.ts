import { PenumbraRequestFailure } from '@penumbra-zone/client/error';
import type { ZafuConnection } from './zafu-connection';

export const sendBackground = async (
  request: ZafuConnection,
): Promise<null | PenumbraRequestFailure> => {
  try {
    const response = await chrome.runtime.sendMessage<ZafuConnection, unknown>(request);

    switch (response) {
      case undefined:
        throw new ReferenceError(`No response to ${request}`);
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
    console.error(error, { fallback, request, error });
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

  signal?.addEventListener('abort', () => chrome.runtime.onMessage.removeListener(wrappedListener));
}
