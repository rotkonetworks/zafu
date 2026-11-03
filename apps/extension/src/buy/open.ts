/**
 * Every way into a buy. The beta build opens buy.html in its own tab; prod
 * opens Peer's buy page for zec with zafu's referral, until the in-wallet buy works
 * again (Peer's curator stopped giving out sellers' handles, 2026-11). Entries
 * carry `data-preload={BUY_PRELOAD}`: the popup's intent preloader (pointer
 * down, hover, focus) runs {@link preloadBuyPage}, registered in the router,
 * which prefetches the page's own chunks - a disk read, never a quote, never a
 * request to Peer, Base or NEAR.
 */

import { IS_BETA_BUILD } from '../config/feature-flags';
import { PEER_BUY_ZEC_URL } from '../config/ramps';

export const BUY_PRELOAD = 'page:buy';

const PAGE_CHUNKS = ['buy-root.js', 'buy-page.js'];

export const preloadBuyPage = (): void => {
  if (!IS_BETA_BUILD) {
    return;
  }
  for (const f of PAGE_CHUNKS) {
    if (!document.head.querySelector(`link[data-buy="${f}"]`)) {
      const l = document.createElement('link');
      l.rel = 'prefetch';
      l.href = `/${f}`;
      l.dataset['buy'] = f;
      document.head.append(l);
    }
  }
};

export const openBuyPage = (): void => {
  void chrome.tabs.create({
    url: IS_BETA_BUILD ? chrome.runtime.getURL('buy.html') : PEER_BUY_ZEC_URL,
  });
};
