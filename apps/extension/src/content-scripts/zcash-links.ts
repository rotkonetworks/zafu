/**
 * `zcash:` payment links (ZIP 321) clicked on a website open in zafu - when
 * the user allows it (privacy > zcash: links, on by default). Switched off,
 * this script never touches the click and the browser hands the link to the
 * system's default Zcash app.
 *
 * Only a real click on a well-formed single-payment link is taken over;
 * anything else (malformed, multi-payment, modified clicks) is left to the
 * browser, so a local app that handles more still gets it.
 */

import { isZip321Uri, parseZip321 } from '@repo/wallet/networks/zcash/zip321';

const OPEN_ZCASH_URI = 'zafu_open_zcash_uri';

let enabled = true; // the setting's default, until storage answers

const apply = (settings: unknown) => {
  enabled = (settings as { openZcashLinks?: unknown } | undefined)?.openZcashLinks !== false;
};

void chrome.storage.local
  .get('privacySettings')
  .then(r => apply(r['privacySettings']))
  .catch(() => undefined);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['privacySettings']) {
    apply(changes['privacySettings'].newValue);
  }
});

document.addEventListener(
  'click',
  event => {
    if (
      !enabled ||
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
    if (!href || href.length > 4096 || !isZip321Uri(href)) {
      return;
    }
    const parsed = parseZip321(href);
    if (!parsed.ok || parsed.payments.length !== 1) {
      return;
    }
    event.preventDefault();
    void chrome.runtime.sendMessage({ type: OPEN_ZCASH_URI, uri: href }).catch(() => undefined);
  },
  true,
);
