/**
 * Messages that reach the worker before its listeners exist.
 *
 * The worker's entry imports wasm, and webpack's asyncWebAssembly makes the
 * entry an async module: its body, where every listener is registered, runs
 * only after the wasm is instantiated. Chrome delivers the message that woke
 * the worker in its first turn, so that message found no listener and was
 * answered with nothing. A site's passkey sign-in on a sleeping worker went
 * to the browser, which has no passkey for it; the same went for a connect,
 * a signature or a keplr call. It only worked while a zafu window kept the
 * worker awake.
 *
 * This module has no async import, so it runs in that first turn. It keeps a
 * message's channel open until the entry body has registered its listeners
 * (`releaseHeldMessages`), then hands it to them as Chrome would have.
 *
 * Only a site's or a content script's message is kept: only the worker
 * answers those. A message from one of zafu's own pages may be for another
 * page (the popup asking the offscreen document to sync), and keeping its
 * channel here, then closing it with nothing at the release, answered it
 * before the page it was for could: sync requests on a cold start came back
 * empty. Those pass through untouched, as before this module existed.
 */

type Listener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response?: unknown) => void,
) => boolean | undefined | void;

/** from one of zafu's own pages (popup, side panel, offscreen), not a site or a content script */
const fromOwnPage = (sender: chrome.runtime.MessageSender): boolean => {
  const own = `chrome-extension://${chrome.runtime.id}`;
  return sender.origin === own || !!sender.url?.startsWith(`${own}/`);
};

const channel = (event: { addListener: (l: never) => void } | undefined) => {
  const listeners: Listener[] = [];
  let held: Parameters<Listener>[] | undefined = [];
  const hold: Listener = (req, sender, respond) => {
    if (!held || fromOwnPage(sender)) {
      return false;
    }
    held.push([req, sender, respond]);
    return true;
  };
  event?.addListener(hold as never);
  return {
    listen: (l: Listener): void => {
      listeners.push(l);
      event?.addListener(l as never);
    },
    release: (): void => {
      const waiting = held ?? [];
      held = undefined;
      for (const [req, sender, respond] of waiting) {
        let answered = false;
        const once = (response?: unknown) => {
          if (!answered) {
            answered = true;
            respond(response);
          }
        };
        // every listener sees it, as with Chrome's own dispatch; one that
        // returns true answers later, and none doing so closes the channel
        const kept = listeners.map(l => {
          try {
            return l(req, sender, once) === true;
          } catch {
            return false;
          }
        });
        if (!kept.includes(true)) {
          once();
        }
      }
    },
  };
};

const internal = channel(globalThis.chrome?.runtime?.onMessage);
const external = channel(globalThis.chrome?.runtime?.onMessageExternal);

/** register an internal message listener (`chrome.runtime.onMessage`) */
export const listen = internal.listen;
/** register a listener for sites (`chrome.runtime.onMessageExternal`) */
export const listenExternal = external.listen;

/** call once, after the last listener is registered */
export const releaseHeldMessages = (): void => {
  internal.release();
  external.release();
};
