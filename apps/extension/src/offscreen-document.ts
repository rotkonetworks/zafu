/**
 * The offscreen document hosts the zcash worker, the provers and the nym
 * tunnel. Only the service worker can create it: other realms ask with
 * `ZCASH_ENSURE_OFFSCREEN`, and the service worker calls this directly.
 */

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);

export const ensureOffscreenDocument = async (): Promise<void> => {
  const contexts = await withTimeout(
    chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] }),
    3000,
    'getContexts',
  );
  if (!contexts.length) {
    await withTimeout(
      chrome.offscreen
        .createDocument({
          url: chrome.runtime.getURL('/offscreen.html'),
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: 'Zcash Halo 2 parallel proving via rayon thread pool',
        })
        .catch(() => {
          /* already exists */
        }),
      3000,
      'createDocument',
    );
  }
};
