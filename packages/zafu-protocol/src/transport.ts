/**
 * @zafu/protocol - the pluggable transport seam.
 *
 * The zafu_* message shapes (./methods) are transport-agnostic: they describe
 * WHAT crosses the wire, never HOW it gets there. A `ZafuTransport` is the HOW -
 * it carries one typed request to a reachable zafu wallet and resolves the
 * typed response. Swapping transports (the extension bridge today; a hosted
 * relay, a native-messaging host, or a mobile deep-link tomorrow) is exactly
 * swapping one implementation of this interface, with no change to the contract
 * or to code written against it.
 *
 * The concrete transports live in the SDK, not here - this package stays
 * dependency-free (no chrome, no DOM) so anything can import the contract.
 */

import type { ZafuMethod, ZafuRequest, ZafuResponse } from './methods';

export interface ZafuTransport {
  /**
   * Resolve true if a zafu wallet is reachable over this transport right now.
   * Used for feature-detection before offering a "login with zafu" affordance.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Send one request and resolve its response.
   *
   * Reject ONLY on transport-level failure - the wallet is unreachable, the
   * message could not be delivered, or a timeout elapsed. An application-level
   * refusal (permission denied, rate limited, wallet locked, bad input) is NOT
   * a rejection: it comes back inside the resolved response as that method's
   * error shape (`{ error }`, or `{ success: false, ... }`), per ./methods.
   * This keeps "the wallet said no" distinct from "there was no wallet".
   *
   * `opts` is additive and MAY be ignored: the two-argument call still
   * typechecks, and an implementation that cannot cancel in flight may drop it.
   * The extension bridge (the only transport today) forwards `opts.signal`
   * NOWHERE - `chrome.runtime.sendMessage` carries no cancellation channel, so
   * an in-flight wallet request is NOT cancelled by aborting the caller; the
   * signal can only prevent a not-yet-dispatched call. A future transport that
   * does have a cancel channel (a relay with request ids, a native host) SHOULD
   * honour it.
   */
  request<M extends ZafuMethod>(
    method: M,
    req: ZafuRequest<M>,
    opts?: ZafuTransportCallOptions,
  ): Promise<ZafuResponse<M>>;
}

/**
 * Optional per-call transport options an implementation MAY honour. Kept
 * separate from the message contract because these are transport concerns
 * (delivery), not part of what the wallet signs or acts on.
 */
export interface ZafuTransportCallOptions {
  /** milliseconds before a request rejects as a timeout, if the transport times out. */
  timeoutMs?: number;
  /** an AbortSignal the caller can use to cancel an in-flight request. */
  signal?: AbortSignal;
}
