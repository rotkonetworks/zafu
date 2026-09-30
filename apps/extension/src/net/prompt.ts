/**
 * The destination consent prompt: the one window that turns an unknown host
 * into a decision.
 *
 * Called from the egress path when the policy says `prompt`. It mirrors the
 * contact-discovery consent flow (same approval-window lifecycle, same
 * per-origin stack guard, same cancelled-on-close semantics) because that flow
 * already solved the two problems this one has: a window the user closes
 * undecided must NOT be recorded as a denial, and a site must not be able to
 * stack prompts into a fatigue click.
 *
 * The decision is persisted here, not by the popup: the ledger is the worker's
 * authority and the popup is only a view of it. `setDestinationDecision` is also
 * what clears `promptedAt`, which is what keeps a refused host from being
 * re-asked on every request.
 *
 * The prompt is keyed by `host`, so two dapps pulling the same unknown endpoint
 * collapse into one question, and a host that is already asking cannot ask
 * twice.
 */

import {
  openApprovalPopup,
  registerPendingApproval,
  takePendingApproval,
} from '../message/listen/external-easteregg';
import { NET_EGRESS_INTERNAL_METHODS } from '../message/listen/zafu-method-names';
import { PopupPath } from '../routes/popup/paths';
import { setDestinationDecision } from './ledger';
import { NET_PURPOSE_LABEL, type NetPurpose } from './purpose';

export type ConsentDecision = 'approved' | 'denied' | 'cancelled';

const RESULT_TYPE = NET_EGRESS_INTERNAL_METHODS[0];

/** requestId -> resolver, settled by the internal result listener. */
const pendingConsent = new Map<string, (decision: ConsentDecision) => void>();

export interface ConsentContext {
  /** why the request is happening, in one line zafu wrote (never a URL) */
  detail?: string;
  /** the page that triggered the request, when there is one */
  origin?: string;
}

/** Persist the answer, then settle the caller exactly once. */
const settle = async (requestId: string, decision: ConsentDecision): Promise<void> => {
  const host = pendingConsentHost.get(requestId);
  const resolve = pendingConsent.get(requestId);
  pendingConsentHost.delete(requestId);
  pendingConsent.delete(requestId);
  if (host) {
    // `cancelled` returns the host to undecided so the question can be asked
    // again later, and never records a denial the user did not make.
    await setDestinationDecision(
      host,
      decision === 'approved' ? 'allowed' : decision === 'denied' ? 'blocked' : 'pending',
    ).catch(() => undefined);
  }
  resolve?.(decision);
};

/** requestId -> the host it is about, so the result listener can persist. */
const pendingConsentHost = new Map<string, string>();

/**
 * Ask the user about `host` and record the answer. Resolves `cancelled` when the
 * window closes undecided (the request is refused now, and the question may be
 * asked again later) or when a prompt for this host is already open.
 */
export const requestDestinationConsent = async (
  host: string,
  purpose: NetPurpose,
  context: ConsentContext = {},
): Promise<ConsentDecision> => {
  const requestId = crypto.randomUUID();
  pendingConsentHost.set(requestId, host);
  const decision = new Promise<ConsentDecision>(resolve => pendingConsent.set(requestId, resolve));

  // Registered BEFORE the window opens so the onRemoved sweep can settle it if
  // the user closes the window immediately.
  registerPendingApproval(requestId, raw => {
    const result = raw as { approved?: boolean; cancelled?: boolean } | undefined;
    void settle(
      requestId,
      result?.cancelled ? 'cancelled' : result?.approved ? 'approved' : 'denied',
    );
  });

  const params = new URLSearchParams({
    host,
    purpose,
    purposeLabel: NET_PURPOSE_LABEL[purpose],
    requestId,
  });
  if (context.origin) {
    params.set('app', context.origin);
  }
  if (context.detail) {
    params.set('detail', context.detail);
  }
  const url = `${chrome.runtime.getURL('popup.html')}#${PopupPath.DESTINATION_APPROVAL}?${params.toString()}`;

  const opened = await openApprovalPopup(host, url, requestId);
  if (!opened) {
    // A prompt for this host is already open, or the window failed to open.
    // Settle cancelled rather than leave the request hanging on a window that
    // does not exist.
    takePendingApproval(requestId);
    await settle(requestId, 'cancelled');
  }

  return decision;
};

/**
 * Internal popup -> worker callback carrying the user's decision. Accepts ONLY
 * from the extension itself: a page that guessed a requestId must not be able to
 * self-deliver a consent.
 */
export const destinationConsentResultListener = (
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
    const result = (req as { result?: { approved?: boolean; cancelled?: boolean } }).result;
    callback({
      approved: result?.approved === true,
      cancelled: result?.cancelled === true,
    });
  }
  sendResponse({ ok: true });
  return true;
};
