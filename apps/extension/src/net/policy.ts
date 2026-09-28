/**
 * The whole decision, as a pure function over ledger state.
 *
 * Kept pure and separate from storage/UI for the same reason `capability-decision`
 * is: this is the part that must be provably exhaustively correct, and the part
 * a reviewer can check by reading one table. Everything else (storage, the
 * prompt window, the fetch wrapper) is plumbing around it.
 *
 * The caller resolves three facts before calling: whether the host is a device
 * on this machine, whether it is already trusted (ships in zafu's config for an
 * enabled network, or the user configured it), and whether the outside-in
 * surface that can introduce untrusted hosts is open (Keplr compat / transparent
 * chain). This function is not allowed to know *why* a host is trusted - only
 * that a user-legible reason exists.
 */

import type { DestinationState } from './destination';

export interface EgressFacts {
  /** the host is a device on this machine (ledger bridge, local node) */
  local: boolean;
  /** ships in zafu's config for an enabled network, or user-configured */
  trusted: boolean;
  /**
   * Keplr compat is on, i.e. undecided untrusted hosts are worth asking about.
   * With it off, nothing should be reaching an untrusted host in the first
   * place, and the answer is a refusal the user can act on - not a prompt they
   * never expected.
   */
  adhocConsentAvailable: boolean;
  /** the recorded decision, absent when the host has never been seen */
  destination?: DestinationState;
}

export type EgressDecision =
  | { action: 'allow' }
  /** the user said no; the caller fails the request */
  | { action: 'refuse'; reason: 'blocked' }
  /** no consent surface is open for this class of host: refuse, and say why */
  | { action: 'refuse'; reason: 'feature-disabled' }
  /** not answered yet: refuse this request and raise the consent surface once */
  | { action: 'prompt' };

const ALLOW: EgressDecision = { action: 'allow' };

/**
 * Precedence, and why:
 *
 *  1. A local device always passes. Nothing to consent to, and a prompt here
 *     would be a prompt on every dev-surface action.
 *  2. An explicit decision on the host wins over everything else. `blocked` is
 *     sticky - the user's refusal is not softened by the host being trusted, and
 *     that is the point of a refusal. `allowed` passes.
 *  3. A trusted host passes without a prompt. Trusted means a user-legible reason
 *     already exists (zafu's own config for a network the user enabled, or an
 *     endpoint they typed). Prompting for these would be asking the user to
 *     approve what they already chose, and would put a prompt storm in front of
 *     a fresh install's own defaults.
 *  4. Everything else is outside-in: a dapp-advertised endpoint, a remote
 *     registry's RPC list. With the Keplr-compat surface open, ask once per host
 *     (the guard re-raises when a `pending` entry is still undecided). With it
 *     closed, refuse and name the reason, because there is no legitimate path
 *     to that host and a prompt would be unexplainable.
 */
export const decideEgress = (facts: EgressFacts): EgressDecision => {
  if (facts.local) return ALLOW;

  if (facts.destination === 'blocked') return { action: 'refuse', reason: 'blocked' };
  if (facts.destination === 'allowed') return ALLOW;

  if (facts.trusted) return ALLOW;

  if (!facts.adhocConsentAvailable) return { action: 'refuse', reason: 'feature-disabled' };
  return { action: 'prompt' };
};
