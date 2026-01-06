export type ValidInternalSender = chrome.runtime.MessageSender & {
  id: typeof ZIGNER;
  url?: `${typeof ZIGNER_ORIGIN}/${string}`;
  origin?: typeof ZIGNER_ORIGIN;
};

/**
 * Checks the sender is an extension worker or page, not a content script or
 * something else.
 */
export const isValidInternalSender = (
  sender?: chrome.runtime.MessageSender,
): sender is ValidInternalSender => {
  try {
    assertValidInternalSender(sender);
    return true;
  } catch {
    return false;
  }
};

/**
 * Asserts the sender is an extension worker or page, not a content script or
 * something else.
 */
export function assertValidInternalSender(
  sender?: chrome.runtime.MessageSender,
): asserts sender is ValidInternalSender {
  // all internal senders will possess the extension id
  if (sender?.id !== ZIGNER) {
    throw new Error(`Sender id is not ${ZIGNER}`, { cause: sender });
  }
  // but so will content scripts, so there's more to check.

  // all extension pages have the extension origin,
  if (sender.origin) {
    // check the origin
    if (sender.origin === ZIGNER_ORIGIN) {
      return; // valid
    }
    throw new Error(`Sender origin is not ${ZIGNER_ORIGIN}`, { cause: sender });
  }
  // but extension workers don't have any origin, so there's more to check.

  // extension workers...
  // - don't have an origin
  // - don't have a documentId
  // - and aren't in a tab
  if (!sender.documentId && !sender.tab && sender.url) {
    // check the url's origin
    if (new URL(sender.url).origin === ZIGNER_ORIGIN) {
      return; //valid
    }
    throw new Error(`Sender URL is from ${ZIGNER_ORIGIN}`, { cause: sender });
  }

  // anything else
  throw new Error('Unexpected sender assumed external', { cause: sender });
}
