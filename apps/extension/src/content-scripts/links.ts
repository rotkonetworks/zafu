/**
 * `zcash:` and `zafu:` links clicked on a website open in zafu, each when the
 * user allows it (privacy > zcash: links, zafu: links; both on by default).
 * Switched off, this script never touches the click.
 *
 * Only a real, unmodified click is taken over. A `zcash:` link zafu can't
 * open (malformed, several payments) is left to the browser, so the system's
 * zcash app still gets it; nothing else opens `zafu:`, so zafu takes those
 * and answers in its own window.
 *
 * A card or group link opened as a page (zafu.pro/c#..., /j#..., say from a
 * chat app) opens in zafu too, once per link, under the zafu: links setting.
 * The `#` part goes only to zafu, never anywhere else.
 */

// egress guard first: nothing may capture fetch or open a socket before it
import '../net/egress-install-lite';
import { notYet, parseLink } from '../links/router';
import { OPEN_LINK, SCHEMES, type LinkSetting } from '../links/schemes';

const enabled: Record<LinkSetting, boolean> = { openZcashLinks: true, openZafuLinks: true };

const apply = (settings: unknown) => {
  for (const key of Object.keys(enabled) as LinkSetting[]) {
    enabled[key] = (settings as Partial<Record<LinkSetting, unknown>> | undefined)?.[key] !== false;
  }
};

const ready = chrome.storage.local
  .get('privacySettings')
  .then(r => apply(r['privacySettings']))
  .catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['privacySettings']) {
    apply(changes['privacySettings'].newValue);
  }
});

/** a zcash: link is ours only when zafu can open it; a zafu: link always is */
const claims = (href: string, ownsMalformed: boolean): boolean => {
  if (ownsMalformed) {
    return true;
  }
  const parsed = parseLink(href);
  return parsed.ok && !notYet(parsed.intent);
};

document.addEventListener(
  'click',
  event => {
    if (
      !event.isTrusted ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = link?.getAttribute('href')?.trim();
    const scheme = href && href.length <= 4096 && SCHEMES.find(s => s.test.test(href));
    if (!href || !scheme || !enabled[scheme.setting] || !claims(href, scheme.ownsMalformed)) {
      return;
    }
    event.preventDefault();
    void chrome.runtime?.sendMessage({ type: OPEN_LINK, uri: href })?.catch(() => undefined);
  },
  true,
);

let opened: string | undefined;

/** this page is a zafu.pro card or group link zafu can open: hand it over once */
const openPage = () => {
  const href = location.href;
  const parsed = parseLink(href);
  if (
    window !== window.top ||
    href === opened ||
    !enabled.openZafuLinks ||
    !parsed.ok ||
    (parsed.intent.kind !== 'contact' && parsed.intent.kind !== 'join')
  ) {
    return;
  }
  opened = href;
  void chrome.runtime?.sendMessage({ type: OPEN_LINK, uri: href })?.catch(() => undefined);
};

void ready.then(openPage);
window.addEventListener('hashchange', () => void ready.then(openPage));
