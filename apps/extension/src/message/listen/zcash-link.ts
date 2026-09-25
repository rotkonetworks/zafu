/**
 * A `zcash:` payment link (ZIP 321) clicked on a website, handed over by the
 * zcash-links content script: open send, prefilled for review. Only when the
 * user lets zafu open these links (privacy > zcash: links); otherwise the
 * content script never intercepts and the system's Zcash app gets the link.
 */

import { parseZip321 } from '@repo/wallet/networks/zcash/zip321';
import { PopupPath } from '../../routes/popup/paths';
import { openWalletRoute } from './external-easteregg';

export const OPEN_ZCASH_URI = 'zafu_open_zcash_uri';

interface OpenZcashUri {
  type: typeof OPEN_ZCASH_URI;
  uri: string;
}

const isOpenZcashUri = (req: unknown): req is OpenZcashUri =>
  typeof req === 'object' &&
  req !== null &&
  (req as { type?: unknown }).type === OPEN_ZCASH_URI &&
  typeof (req as { uri?: unknown }).uri === 'string';

export const zcashLinkListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (r: { opened: boolean }) => void,
): boolean => {
  // our own content scripts, in a page tab
  if (!isOpenZcashUri(req) || sender.id !== chrome.runtime.id || !sender.tab || !sender.origin) {
    return false;
  }
  const origin = sender.origin;
  void (async () => {
    const stored = (await chrome.storage.local.get('privacySettings'))['privacySettings'] as
      | { openZcashLinks?: boolean }
      | undefined;
    const parsed = parseZip321(req.uri);
    if (stored?.openZcashLinks === false || !parsed.ok || parsed.payments.length !== 1) {
      respond({ opened: false });
      return;
    }
    const route = `${PopupPath.SEND}?to=${encodeURIComponent(req.uri)}`;
    respond({ opened: await openWalletRoute(origin, route) });
  })().catch(() => respond({ opened: false }));
  return true;
};
