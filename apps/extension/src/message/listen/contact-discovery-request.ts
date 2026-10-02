/**
 * external message listener - the private-contact-discovery CONSENT request.
 *
 * Handles `zafu_request_contact_discovery` (see @zafu/protocol): a dapp asks
 * the USER to turn private contact discovery on. It is the complement of
 * `zafu_discover_contacts`, which SERVES the feature and refuses
 * `not_available` while it is off - so an app that needs presence gets a
 * first-class way to ask rather than telling the user to hunt for a settings
 * screen. A sibling module (rather than living beside zafu_discover_contacts)
 * because contact-discovery.ts is deliberately popup-free; this one owns the
 * consent popup.
 *
 * Fixed wire semantics:
 *   - the request carries NO relay endpoint and NO token. The wallet's own
 *     configured relay (else the built-in DEFAULT_CONTACT_DISCOVERY_RELAY) is
 *     used, so an app can never point the wallet at a relay of its choosing;
 *   - accepting turns discovery on and grants THIS site only ("friends can
 *     find you here"); every other site needs its own grant. The first grant
 *     is also the opt-in for the one discovery relay destination;
 *   - accepting starts presence for this site while its page is open;
 *   - a denial is NOT remembered (unlike a capability): nothing is persisted
 *     and the caller may ask again;
 *   - if the feature is on and this site already holds the grant, the request
 *     resolves immediately and no popup is shown.
 *
 * Refusals use the standard `{ error, code }` shape: `denied` (bad sender or
 * user declined), `cancelled` (popup closed undecided), `not_available`
 * (wallet locked - the uniform "can't serve this" idiom that
 * zafu_discover_contacts also uses).
 *
 * Window lifecycle is shared with the other approval flows: the popup is
 * opened via external-easteregg's per-origin guard, and the `chrome.windows.
 * onRemoved` sweep resolves the request `cancelled` if the user closes the
 * window without deciding - never a denial the user did not make.
 */

import type {
  ZafuRequestContactDiscoveryRequest,
  ZafuRequestContactDiscoveryResponse,
} from '@zafu/protocol';
import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { isValidExternalSender } from '../../senders/external';
import { DEFAULT_CONTACT_DISCOVERY_RELAY } from '../../config/contact-discovery-relay';
import { setSiteFindsFriends, siteFindsFriends } from '../../state/find-friends';
import { PopupPath } from '../../routes/popup/paths';
import { holdTab } from '../../discovery-presence-port';
import {
  openApprovalPopup,
  registerPendingApproval,
  takePendingApproval,
} from './external-easteregg';
import {
  CONTACT_DISCOVERY_INTERNAL_METHODS,
  CONTACT_DISCOVERY_REQUEST_METHODS,
} from './zafu-method-names';

const REQUEST_TYPE = CONTACT_DISCOVERY_REQUEST_METHODS[0];
const RESULT_TYPE = CONTACT_DISCOVERY_INTERNAL_METHODS[0];

/** The uniform "can't serve this" refusal: the wallet is locked. ONE message
 *  and code so a caller cannot fingerprint the wallet's state. */
const NOT_AVAILABLE: ZafuRequestContactDiscoveryResponse = {
  error: 'contact discovery is not available',
  code: 'not_available',
};

/** the user's decision in the consent popup. */
export type ConsentDecision = 'approved' | 'denied' | 'cancelled';

export interface ContactDiscoveryRequestDeps {
  /** current wallet-wide discovery settings; `enabled` short-circuits (no popup).
   *  `relayEndpoint` is the EFFECTIVE endpoint (configured, else the built-in
   *  default) - it is shown to the USER in the consent popup and deliberately
   *  never crosses back to the app. */
  settings: () => Promise<{ enabled: boolean; relayEndpoint: string }>;
  /** true when the wallet is locked. */
  locked: () => Promise<boolean>;
  /** this site already holds the "friends can find you here" grant */
  siteAllowed: (origin: string) => Promise<boolean>;
  /** grant this site, and turn discovery on PRESERVING any configured endpoint/token. */
  enable: (origin: string) => Promise<void>;
  /** the site's open page may hold presence now (it said yes: "friends here will see you are online") */
  hold?: (tabId: number) => void;
  /** show the consent popup and resolve the user's decision. */
  prompt: (
    origin: string,
    favIconUrl: string,
    title: string,
    relay: string,
  ) => Promise<ConsentDecision>;
}

const isRequest = (req: unknown): req is ZafuRequestContactDiscoveryRequest =>
  typeof req === 'object' && req !== null && (req as { type?: unknown }).type === REQUEST_TYPE;

/**
 * Build the consent-request listener around injectable deps so the
 * accept/deny/already-enabled/locked contract is testable without chrome (see
 * contact-discovery-request.test.ts); the default export below wires the real
 * storage + popup deps.
 */
export const createContactDiscoveryRequestListener =
  (deps: ContactDiscoveryRequestDeps) =>
  (
    req: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: ZafuRequestContactDiscoveryResponse) => void,
  ): boolean => {
    if (!isRequest(req)) {
      return false;
    }

    if (!isValidExternalSender(sender)) {
      sendResponse({ success: false, error: 'denied', code: 'denied' });
      return true;
    }

    const origin = sender.origin;
    const favIconUrl = sender.tab?.favIconUrl || '';
    const title = sender.tab?.title || '';
    const tabId = sender.tab.id;

    void (async () => {
      try {
        const { enabled, relayEndpoint } = await deps.settings();
        if (enabled && (await deps.siteAllowed(origin))) {
          // Already on for this site: nothing to ask and nothing to change.
          deps.hold?.(tabId);
          sendResponse({ success: true, enabled: true });
          return;
        }
        if (await deps.locked()) {
          sendResponse(NOT_AVAILABLE);
          return;
        }
        // The effective endpoint goes to the POPUP only, so the user consents to
        // the relay that will really be used. It is never echoed to the app: for
        // a self-hosted relay the hostname identifies the user, and the app has
        // no use for it - it can only ask the wallet to discover contacts.
        const decision = await deps.prompt(origin, favIconUrl, title, relayEndpoint);
        if (decision === 'approved') {
          await deps.enable(origin);
          deps.hold?.(tabId);
          sendResponse({ success: true, enabled: true });
        } else if (decision === 'cancelled') {
          sendResponse({ success: false, error: 'cancelled', cancelled: true });
        } else {
          sendResponse({ success: false, error: 'denied', code: 'denied' });
        }
      } catch {
        // storage/keyring reads can throw; answer so the channel closes cleanly.
        sendResponse(NOT_AVAILABLE);
      }
    })();

    return true;
  };

/** requestId -> the resolver the consent-result callback settles. */
const pendingConsent = new Map<string, (d: ConsentDecision) => void>();

/** Open the consent popup and resolve once the user decides (or the window is
 *  closed undecided -> `cancelled`). */
const openConsentPopup = async (
  origin: string,
  favIconUrl: string,
  title: string,
  relay: string,
): Promise<ConsentDecision> => {
  const requestId = crypto.randomUUID();
  const decision = new Promise<ConsentDecision>(resolve => pendingConsent.set(requestId, resolve));

  // Register with the shared approval registry so the onRemoved sweep settles
  // a window the user closed without deciding (cancelled), and so a second
  // request from the same origin cannot stack a popup.
  registerPendingApproval(requestId, r => {
    const res = r as { approved?: boolean; cancelled?: boolean } | undefined;
    const settle = pendingConsent.get(requestId);
    if (!settle) {
      return;
    }
    pendingConsent.delete(requestId);
    settle(res?.cancelled ? 'cancelled' : res?.approved ? 'approved' : 'denied');
  });

  const params = new URLSearchParams({ app: origin, requestId, favIconUrl, title, relay });
  const url = `${chrome.runtime.getURL('popup.html')}#${PopupPath.CONTACT_DISCOVERY_APPROVAL}?${params.toString()}`;
  const opened = await openApprovalPopup(origin, url, requestId);
  if (!opened) {
    // Already-open window for this origin, or create failed: drop the pending
    // entry and settle cancelled so the caller is not left hanging.
    takePendingApproval(requestId);
    const settle = pendingConsent.get(requestId);
    if (settle) {
      pendingConsent.delete(requestId);
      settle('cancelled');
    }
  }
  return decision;
};

/**
 * The real deps, backed by extension storage + the keyring. Exported so a test
 * can prove the accept path writes `zidDiscovery` with a BLANK endpoint.
 */
export const contactDiscoveryRequestDeps: ContactDiscoveryRequestDeps = {
  settings: async () => {
    const stored = await localExtStorage.get('zidDiscovery');
    return {
      enabled: stored?.enabled === true,
      // Blank means the built-in default (an explicit endpoint the user typed
      // always wins). Computed here so the success reply names the real relay.
      relayEndpoint: (stored?.relayEndpoint ?? '').trim() || DEFAULT_CONTACT_DISCOVERY_RELAY,
    };
  },
  locked: async () => !(await sessionExtStorage.get('passwordKey')),
  siteAllowed: siteFindsFriends,
  // Flips the wallet-wide flag (keeping a relay the person set up) and grants
  // this one site. Every other site still needs its own grant.
  enable: origin => setSiteFindsFriends(origin, true),
  hold: holdTab,
  prompt: openConsentPopup,
};

export const contactDiscoveryRequestListener = createContactDiscoveryRequestListener(
  contactDiscoveryRequestDeps,
);

/**
 * Internal popup->worker callback: the consent popup reports the user's
 * decision. Accept ONLY from the extension itself - a web page that guessed a
 * requestId could otherwise self-deliver a forged consent.
 */
export const contactDiscoveryRequestResultListener = (
  req: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): boolean => {
  if (typeof req !== 'object' || req === null || (req as { type?: unknown }).type !== RESULT_TYPE) {
    return false;
  }
  if (sender.id !== chrome.runtime.id) {
    return false;
  }
  const requestId = String((req as { requestId?: unknown }).requestId ?? '');
  const callback = takePendingApproval(requestId);
  if (callback) {
    const result = (req as { result?: { approved?: boolean } }).result;
    callback({ approved: result?.approved === true });
  }
  sendResponse({ ok: true });
  return true;
};
