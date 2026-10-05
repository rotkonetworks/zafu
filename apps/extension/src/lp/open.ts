/**
 * Every way into lp.html (the zec sheet's row, the tools tile, the home card,
 * the swap's "deepen this pool"). A press opens the page in its own tab; the
 * popup's intent preloader prefetches the page's own chunks, a disk read and
 * never a request to THORNode or Midgard.
 */

export const LP_PRELOAD = 'page:lp';

const PAGE_CHUNKS = ['lp-root.js', 'lp-page.js'];

export const preloadLpPage = (): void => {
  for (const f of PAGE_CHUNKS) {
    if (!document.head.querySelector(`link[data-lp="${f}"]`)) {
      const l = document.createElement('link');
      l.rel = 'prefetch';
      l.href = `/${f}`;
      l.dataset['lp'] = f;
      document.head.append(l);
    }
  }
};

export const openLpPage = (): void => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('lp.html') });
};
