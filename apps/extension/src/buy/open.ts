/**
 * Every way into buy.html. A press opens the page in its own tab. Entries
 * carry `data-preload={BUY_PRELOAD}`: the popup's intent preloader (pointer
 * down, hover, focus) runs {@link preloadBuyPage}, registered in the router,
 * which prefetches the page's own chunks - a disk read, never a quote, never a
 * request to Peer, Base or NEAR.
 */

export const BUY_PRELOAD = 'page:buy';

const PAGE_CHUNKS = ['buy-root.js', 'buy-page.js'];

export const preloadBuyPage = (): void => {
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
  void chrome.tabs.create({ url: chrome.runtime.getURL('buy.html') });
};
