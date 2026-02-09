// In dev mode, use runtime ID (Chrome assigns dynamic ID for unpacked extensions)
// In prod, use the hardcoded ZIGNER constant
const getExtensionId = () => (globalThis.__DEV__ ? chrome.runtime.id : ZIGNER);
const getExtensionOrigin = () => (globalThis.__DEV__ ? `chrome-extension://${chrome.runtime.id}` : ZIGNER_ORIGIN);

export type ValidInternalSender = chrome.runtime.MessageSender & {
  id: string;
  url?: string;
  origin?: string;
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
  const extensionId = getExtensionId();
  const extensionOrigin = getExtensionOrigin();

  // all internal senders will possess the extension id
  if (sender?.id !== extensionId) {
    throw new Error(`Sender id is not ${extensionId}`, { cause: sender });
  }
  // but so will content scripts, so there's more to check.

  // all extension pages have the extension origin,
  if (sender.origin) {
    // check the origin
    if (sender.origin === extensionOrigin) {
      return; // valid
    }
    throw new Error(`Sender origin is not ${extensionOrigin}`, { cause: sender });
  }
  // but extension workers don't have any origin, so there's more to check.

  // extension workers...
  // - don't have an origin
  // - don't have a documentId
  // - and aren't in a tab
  if (!sender.documentId && !sender.tab && sender.url) {
    // check the url's origin
    if (new URL(sender.url).origin === extensionOrigin) {
      return; //valid
    }
    throw new Error(`Sender URL is from ${extensionOrigin}`, { cause: sender });
  }

  // anything else
  throw new Error('Unexpected sender assumed external', { cause: sender });
}
