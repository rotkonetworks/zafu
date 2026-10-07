/**
 * ISOLATED-world bridge for the passkey intercept. The MAIN-world intercept
 * (passkey-intercept.ts) has no chrome.runtime access, so it posts calls to the
 * window; this script relays them to the service worker and posts the response
 * back. Everything crossing the wire is plain JSON - hex strings, never binary.
 *
 * It asks only after a click on the page, and after "not now" or a closed
 * window it waits before asking again (promptCooldown), so a page cannot loop
 * the passkey screen.
 *
 * Trust note: this bridge carries the request, it never authorises anything.
 * The service worker derives the origin from the browser-attested sender (not
 * from anything here) and checks the rpId against it, so a page cannot use the
 * bridge to act for another origin.
 */
// egress guard first: nothing may capture fetch or open a socket before it
import '../net/egress-install-lite';

import { passkeyMessage, promptCooldown } from './passkey-wire';

const CHANNEL = 'zafu-passkey';

const cooldown = promptCooldown();

interface PasskeyWireRequest {
  channel: string;
  direction: string;
  id: string;
  kind: string;
  payload: unknown;
}

const isPasskeyRequest = (d: unknown): d is PasskeyWireRequest =>
  typeof d === 'object' &&
  d !== null &&
  (d as { channel?: unknown }).channel === CHANNEL &&
  (d as { direction?: unknown }).direction === 'request' &&
  typeof (d as { id?: unknown }).id === 'string' &&
  typeof (d as { kind?: unknown }).kind === 'string';

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window || !isPasskeyRequest(ev.data)) {
    return;
  }
  const { id, kind, payload } = ev.data;

  // a missing `result` is "wallet unavailable" on the other side, which falls
  // back to the platform authenticator - never a silent hang.
  const respond = (result?: unknown) =>
    window.postMessage({ channel: CHANNEL, direction: 'response', id, result }, window.origin);

  // only the fields this kind uses, with `type` set here - never the page's
  const message = passkeyMessage(kind, payload);
  // a passkey screen only follows a click on the page, and not while the page
  // is waiting out a "not now"; activation is per frame, so this world sees
  // the page's own click
  const asked = navigator.userActivation?.isActive && !cooldown.quiet(Date.now());
  // orphaned content script (extension reloaded in an open tab) - fail cleanly
  if (!message || !asked || !chrome.runtime?.id || chrome.runtime.id === 'invalid') {
    respond(undefined);
    return;
  }

  chrome.runtime
    .sendMessage(message)
    .then((res: unknown) => {
      cooldown.after(res, Date.now());
      respond(res);
    })
    .catch(() => respond(undefined));
});
