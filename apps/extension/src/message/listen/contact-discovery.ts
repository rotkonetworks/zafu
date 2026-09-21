/**
 * external message listener - private, app-scoped contact discovery.
 *
 * Handles `zafu_discover_contacts` (see @zafu/protocol): the app asks which of
 * the user's contacts are present in THIS app scope this epoch, and gets back
 * only the present intersection under app-scoped opaque handles. The wallet
 * holds the pairwise secrets; the app never does.
 *
 * Gate: a valid top-frame https sender (isValidExternalSender), then a per-origin
 * rate limit. There is no per-request popup - the privacy design is what makes
 * the method safe for arbitrary origins: the reply reveals nothing the caller
 * did not already hold a handle for, and the whole feature is opt-in and off by
 * default. The wallet resolves the app scope from the browser-ATTESTED origin,
 * never from the caller-supplied field, so a page cannot ask about another
 * origin's scope.
 *
 * Refusals use the standard `{ error, code }` shape. "Can't serve this" (feature
 * off, no relay configured, wallet locked, no identity) is ONE uniform
 * `not_available` so a hostile origin cannot fingerprint the wallet's state.
 *
 * CANCELLATION: `chrome.runtime.sendMessage` carries no cancellation channel,
 * so a caller's `AbortSignal` (ZafuTransportCallOptions) never reaches this
 * handler - an in-flight discovery runs to completion and its response is
 * dropped if the caller is gone. There is deliberately no cancel stub here.
 */

import type { ZafuDiscoverContactsRequest, ZafuDiscoverContactsResponse } from '@zafu/protocol';
import { isValidExternalSender } from '../../senders/external';
import {
  contactDiscoveryDeps,
  runDiscoveryForScope,
  type ContactDiscoveryDeps,
} from '../../state/contact-discovery-service';
import { CONTACT_DISCOVERY_METHODS } from './zafu-method-names';

const DISCOVER_TYPE = CONTACT_DISCOVERY_METHODS[0];

// Rate limiting - discovery hits a relay, so the budget is tighter than the
// encryption surface's. Per-origin sliding window, same shape as siblings.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

const callLog = new Map<string, number[]>();

const isRateLimited = (origin: string): boolean => {
  const now = Date.now();
  const recent = (callLog.get(origin) ?? []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  callLog.set(origin, recent);
  if (recent.length >= RATE_LIMIT_MAX) {
    return true;
  }
  recent.push(now);
  return false;
};

const isDiscoverRequest = (req: unknown): req is ZafuDiscoverContactsRequest =>
  typeof req === 'object' && req !== null && (req as { type?: unknown }).type === DISCOVER_TYPE;

/**
 * Build the listener around injectable deps so the refusal/validation/response
 * contract is testable with a fake relay (see contact-discovery.test.ts); the
 * default export below wires the real storage/keyring deps.
 */
export const createContactDiscoveryListener =
  (deps: ContactDiscoveryDeps) =>
  (
    req: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: ZafuDiscoverContactsResponse) => void,
  ): boolean => {
    if (!isDiscoverRequest(req)) {
      return false;
    }

    if (!isValidExternalSender(sender)) {
      sendResponse({ error: 'denied', code: 'denied' });
      return true;
    }

    const origin = sender.origin;

    if (isRateLimited(origin)) {
      sendResponse({ error: 'rate limited', code: 'rate_limited' });
      return true;
    }

    // The request must name the caller's OWN scope. The attested origin is
    // authoritative; a mismatch is malformed (never serve another scope).
    if (typeof req.appScope !== 'string' || req.appScope.length === 0) {
      sendResponse({ error: 'appScope required', code: 'invalid_request' });
      return true;
    }
    if (req.appScope !== origin) {
      sendResponse({
        error: 'appScope does not match the calling origin',
        code: 'invalid_request',
      });
      return true;
    }

    void runDiscoveryForScope(origin, deps).then(sendResponse);
    return true;
  };

export const contactDiscoveryListener = createContactDiscoveryListener(contactDiscoveryDeps);
