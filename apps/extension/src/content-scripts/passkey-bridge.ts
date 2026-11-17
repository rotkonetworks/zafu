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

import { passkeyMessage, passkeyPageResult, promptCooldown, recentHand } from './passkey-wire';

const CHANNEL = 'zafu-passkey';

const cooldown = promptCooldown();
const hand = recentHand();
// a sign-in page often asks as it loads: the click was on the page before it
// (the app's "sign in", a redirect, then the login page calls WebAuthn itself).
// So one sign-in per page needs no click here; after that, and for making a
// passkey, a click on this page is asked. The worker only shows a screen for a
// site that already holds a zafu passkey, so this gives no other page a prompt.
let freeSignIn = true;
// the person's own clicks and key presses on this page (never a page's synthetic ones)
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(
    type,
    ev => {
      if (ev.isTrusted) {
        hand.saw(Date.now());
      }
    },
    { capture: true, passive: true },
  );
}

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
  // a passkey screen follows a click on the page (or is this page's one free
  // sign-in), and not while the page is waiting out a "not now"; activation
  // is per frame, so this world sees the page's own click
  const now = Date.now();
  const clicked = hand.asked(now, navigator.userActivation?.isActive);
  const free = kind === 'get' && freeSignIn && !clicked;
  const asked = (clicked || free) && !cooldown.quiet(now, hand.last());
  if (free && message) {
    freeSignIn = false;
  }
  // orphaned content script (extension reloaded in an open tab) - fail cleanly
  if (!message || !asked || !chrome.runtime?.id || chrome.runtime.id === 'invalid') {
    console.info(
      `[zafu] passkey ${kind} left to the browser:`,
      !message
        ? 'not a request zafu takes'
        : !asked
          ? cooldown.quiet(now, hand.last())
            ? 'waiting after "not now"'
            : 'no click on this page in the last minute, and its one sign-in without a click is used'
          : 'zafu was reloaded, reload this page',
    );
    respond(undefined);
    return;
  }

  chrome.runtime
    .sendMessage(message)
    .then((res: unknown) => {
      const result = passkeyPageResult(res);
      if ((result as { success?: unknown } | undefined)?.success !== true) {
        // why zafu did not sign: its own words, for whoever opens this console
        console.info(`[zafu] passkey ${kind} not answered by zafu ·`, JSON.stringify(res));
      }
      cooldown.after(result, Date.now());
      respond(result);
    })
    .catch((e: unknown) => {
      console.info(`[zafu] passkey ${kind} left to the browser: zafu did not answer ·`, e);
      respond(undefined);
    });
});
