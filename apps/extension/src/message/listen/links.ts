/**
 * A link clicked on a website, handed over by the links content script: open
 * the link route, which shows the screen it fills for review. The page's
 * origin is stamped here, from the sender, never read from the link.
 */

import { notYet, parseLink } from '../../links/router';
import { OPEN_LINK, SCHEMES } from '../../links/schemes';
import { PopupPath } from '../../routes/popup/paths';
import { openWalletRoute } from './external-easteregg';

interface OpenLink {
  type: typeof OPEN_LINK;
  uri: string;
}

const isOpenLink = (req: unknown): req is OpenLink =>
  typeof req === 'object' &&
  req !== null &&
  (req as { type?: unknown }).type === OPEN_LINK &&
  typeof (req as { uri?: unknown }).uri === 'string';

export const linkListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (r: { opened: boolean }) => void,
): boolean => {
  // our own content scripts, in a page tab
  if (!isOpenLink(req) || sender.id !== chrome.runtime.id || !sender.tab || !sender.origin) {
    return false;
  }
  const origin = sender.origin;
  void (async () => {
    const uri = req.uri.trim();
    const scheme = SCHEMES.find(s => s.test.test(uri));
    const stored = (await chrome.storage.local.get('privacySettings'))['privacySettings'] as
      | Record<string, unknown>
      | undefined;
    const parsed = parseLink(uri);
    const opens =
      !!scheme &&
      uri.length <= 4096 &&
      stored?.[scheme.setting] !== false &&
      (scheme.ownsMalformed || (parsed.ok && !notYet(parsed.intent)));
    if (!opens) {
      respond({ opened: false });
      return;
    }
    const route = `${PopupPath.LINK}?uri=${encodeURIComponent(uri)}&via=${encodeURIComponent(origin)}`;
    respond({ opened: await openWalletRoute(origin, route) });
  })().catch(() => respond({ opened: false }));
  return true;
};
