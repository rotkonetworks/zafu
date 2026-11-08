/**
 * Logging in to the person's HTTP(S) proxy before zafu's own requests need it.
 *
 * Chrome does not raise webRequest.onAuthRequired for requests an extension
 * makes itself (its service worker, its pages' fetches), so those meet the
 * proxy's 407 with no one to answer. A frame's navigation does raise it, and
 * once answered Chrome keeps the login for that proxy, so zafu's own
 * requests then carry it. One short-lived frame, to a zafu host the PAC
 * sends through the proxy, at the moments the kept login can be missing: the
 * proxy turned on or changed, an unlock, the browser started, a check.
 *
 * It is not a way around the egress guard: the frame loads a path on a host
 * zafu is already allowed to reach, and nothing is read from it.
 */

export const PRIME_PROXY = 'PRIME_PROXY';

/** a path no zafu host serves: only the proxy's login matters, not the answer */
export const primerUrl = (host: string): string => `https://${host}/zafu-proxy-check`;

/** load `url` in a hidden frame of `doc`, then drop it; resolves when it settled or after `ms` */
export const primeIn = (doc: Document, url: string, ms = 10_000): Promise<void> =>
  new Promise(resolve => {
    const frame = doc.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    // nothing in it may run or reach back
    frame.setAttribute('sandbox', '');
    const done = () => {
      clearTimeout(timer);
      frame.remove();
      resolve();
    };
    const timer = setTimeout(done, ms);
    frame.addEventListener('load', done, { once: true });
    frame.addEventListener('error', done, { once: true });
    frame.src = url;
    doc.body.appendChild(frame);
  });
