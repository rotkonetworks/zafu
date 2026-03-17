/**
 * external message listener — handles messages from websites via externally_connectable
 *
 * supports:
 * - { type: 'ping' } → responds with { zafu: true, version } for detection
 * - { type: 'send', address, network? } → opens popup with send page prefilled
 */

export const externalMessageListener = (
  req: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
) => {
  if (typeof req !== 'object' || req === null || !('type' in req)) {
    sendResponse({ error: 'invalid message' });
    return true;
  }

  const msg = req as { type: string; address?: string; network?: string };

  switch (msg.type) {
    case 'ping':
      sendResponse({ zafu: true, version: chrome.runtime.getManifest().version });
      return true;

    case 'send': {
      if (!msg.address || typeof msg.address !== 'string') {
        sendResponse({ error: 'address required' });
        return true;
      }
      // open the extension popup with the send page and prefilled address
      const url = chrome.runtime.getURL(`popup.html#/send?to=${encodeURIComponent(msg.address)}`);
      void chrome.windows.create({
        url,
        type: 'popup',
        width: 400,
        height: 628,
      });
      sendResponse({ ok: true });
      return true;
    }

    default:
      sendResponse({ error: 'unknown message type' });
      return true;
  }
};
