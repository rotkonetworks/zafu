/**
 * The egress gate: the one place that decides whether a network request may
 * leave zafu, and the only place that opens the consent prompt.
 *
 * Every caller that talks to a host zafu did not ship does so through
 * {@link gateEgress}, which resolves the facts the policy needs (local device?
 * in zafu's inventory? already decided? is the outside-in surface open?), runs
 * the pure decision, and - when the answer is "ask" - raises the prompt once per
 * host and waits for it. The result is a plain allow/deny plus the reason, so the
 * caller can fail the request with a message the user can act on instead of a
 * bare `TypeError: Failed to fetch`.
 *
 * What this deliberately does NOT gate: loopback. The ledger/speculos bridge and
 * a node the user runs on this machine are not third parties, and prompting for
 * them would be friction with no privacy content.
 *
 * Keplr compat (the outside-in surface that lets a dapp introduce a host) is read
 * once per realm and invalidated on change: the gate runs on the request path, so
 * a `chrome.storage` round trip per request would be paid on every fetch.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { hostOf, isLocalDeviceHost } from './destination';
import { trustedDestinationFor } from './inventory';
import { markPrompted, noteDestination, recordOutcome, shouldPrompt } from './ledger';
import { decideEgress } from './policy';
import { requestDestinationConsent } from './prompt';
import type { NetPurpose } from './purpose';

export interface EgressOptions {
  /**
   * Why zafu is contacting the host. Rendered in the prompt ("to fetch your
   * Zcash blocks") and stored on the destination, which is what makes the
   * decision legible months later. Callers that do not classify their traffic
   * inherit what the inventory says the host is for, else `other` - honestly
   * unclassified, never a silent `chain-rpc`.
   */
  purpose?: NetPurpose;
  /** the page whose action caused the request, when there is one */
  origin?: string;
  /** one line of context for the audit trail; never a URL with parameters */
  detail?: string;
}

export type EgressRefusal = 'blocked' | 'feature-disabled' | 'consent-required' | 'consent-denied';

export type EgressGate =
  | { allow: true }
  | {
      allow: false;
      reason: EgressRefusal;
      /** the destination key, for the caller's message */
      host: string;
      /** where the host came from, for the caller's message */
      label: string;
    };

const ALLOW: EgressGate = { allow: true };

let keplrCompatOn: boolean | undefined;

if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['keplrCompat']) {
      keplrCompatOn = undefined;
    }
  });
}

const adhocConsentAvailable = async (): Promise<boolean> => {
  keplrCompatOn ??= (await localExtStorage.get('keplrCompat')) === true;
  return keplrCompatOn;
};

/** The user-facing explanation of a refusal, ready to attach to a thrown error. */
export const egressRefusalMessage = (refusal: EgressRefusal, host: string): string => {
  switch (refusal) {
    case 'blocked':
      return `zafu is not allowed to connect to ${host} (blocked in Settings > Networks).`;
    case 'feature-disabled':
      return `zafu does not connect to ${host}: it is not an endpoint zafu ships or you configured, and the Keplr-compatible site surface is off.`;
    case 'consent-denied':
      return `zafu is not allowed to connect to ${host} (you declined just now).`;
    case 'consent-required':
      return `zafu asked you about connecting to ${host} and has no answer yet.`;
  }
};

/**
 * Decide whether a request may proceed. `input` is anything fetch accepts, so a
 * caller can pass through what it already has; a non-network URL (data:, blob:,
 * chrome-extension:) is not a destination and always passes.
 */
export const gateEgress = async (
  input: string | URL | Request,
  options: EgressOptions = {},
): Promise<EgressGate> => {
  const host = hostOf(input);
  if (!host) return ALLOW;

  const local = isLocalDeviceHost(host);
  const inventory = local ? undefined : await trustedDestinationFor(host);
  // What the inventory says the host is for, when the caller did not classify
  // the request itself: one lookup answers both trust and purpose.
  const purpose: NetPurpose = options.purpose ?? inventory?.purposes[0] ?? 'other';
  const trusted = local || Boolean(inventory);
  const label = local
    ? 'a device on this computer'
    : (inventory?.label ??
      (options.origin ? `advertised by ${options.origin}` : "not in zafu's config"));

  // Records the observation (and the purpose) even when the answer is a refusal:
  // "zafu tried to reach this and why" is exactly what the settings list is for.
  const record = await noteDestination(host, { purpose, trusted, label });

  const decision = decideEgress({
    local,
    trusted,
    adhocConsentAvailable: await adhocConsentAvailable(),
    destination: record.state,
  });

  if (decision.action === 'allow') return ALLOW;

  if (decision.action === 'refuse') {
    await recordOutcome(host, purpose, decision.reason, options.detail);
    return { allow: false, reason: decision.reason, host, label };
  }

  // Ask once per host: a request that arrives while the question is open (or
  // after a service-worker restart during an open prompt) is refused now rather
  // than stacking a second window.
  if (!(await shouldPrompt(host))) {
    await recordOutcome(host, purpose, 'consent-required', options.detail);
    return { allow: false, reason: 'consent-required', host, label };
  }
  await markPrompted(host);
  await recordOutcome(host, purpose, 'consent-required', options.detail);

  const answer = await requestDestinationConsent(host, purpose, {
    origin: options.origin,
    detail: options.detail,
  });
  if (answer === 'approved') return ALLOW;

  // The prompt persisted the answer (`allowed` / `blocked` / back to pending for
  // a cancelled window), so the next request takes the ledger's word for it.
  return {
    allow: false,
    reason: answer === 'denied' ? 'consent-denied' : 'consent-required',
    host,
    label,
  };
};
