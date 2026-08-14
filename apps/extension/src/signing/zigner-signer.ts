/**
 * The zigner (air-gapped QR) cold signer, presented as an `ExternalSigner`.
 *
 * zigner is a SUSPENDED-topology signer (see the ExternalSigner doc in
 * external-signer.ts). Unlike Ledger WebHID or a self-custody FROST round -
 * where the whole request -> response happens inside the returned Promise - the
 * zigner signature returns ACROSS A UI CYCLE:
 *
 *   1. the host builds the unsigned PCZT and displays it as an animated UR
 *      (AnimatedQrDisplay), then yields control back to the user;
 *   2. the user carries those frames to the air-gapped zigner device, which
 *      signs offline;
 *   3. the user points the host's camera at the device's response and the scan
 *      handler reconstructs the signed PCZT.
 *
 * The `ExternalSigner` contract is `SignRequest -> Promise<SignResult>`, so to
 * fit zigner into `signAndBroadcast` (cold-send.ts) as ONE service - instead of
 * the current explicit two-phase flow in zcash-send.tsx - the returned Promise
 * must be a DEFERRED: `signer(req)` displays the request and then parks,
 * resolving only when the scan handler calls `deliver(signedPcztHex)`. The
 * result is always the `signedPczt` variant, because that is zigner's delivery
 * form (the device returns a fully-signed PCZT - or, on the compact path, the
 * host merges contributions into one before delivery - which the tail EXTRACTS
 * pool-agnostically; there is no orchard-only inject step, so this path also
 * carries ironwood).
 *
 * ========================================================================
 * TEARDOWN CONSTRAINT - stated honestly, not papered over
 * ========================================================================
 *
 * This is an IN-MEMORY Deferred. The Promise, its resolve/reject, and the
 * `settled`/`awaited` flags below all live in the JS heap of whichever surface
 * called `createZignerSigner`. They do NOT survive that process being torn
 * down. If the signer is created in the browser-action POPUP, the popup is
 * destroyed the moment it loses focus - which is exactly what happens when the
 * user turns to the phone to scan - and the parked Promise dies UNSETTLED with
 * it: `signAndBroadcast`'s `await` never returns, and nothing rejects it either.
 *
 * Therefore this signer REQUIRES the signing surface to stay alive for the full
 * display -> sign -> scan duration. In practice that means running the send from
 * a persistent surface - a full TAB or the SIDE PANEL - not the ephemeral popup.
 * This is the SAME liveness constraint the Ledger WebHID path already enforces
 * (a WebHID session is likewise bound to the calling surface's lifetime), so it
 * is not a new limitation zigner introduces - it is the existing bar.
 *
 * What a RESUMABLE (survives-teardown) design would additionally need - and why
 * an in-memory Deferred deliberately does NOT attempt it:
 *
 *   - PERSISTED PENDING STATE: the unsigned PCZT, `coldSendId`, `spendIndices`,
 *     mainnet flag, and requested response format (compact vs full) written to
 *     durable storage (chrome.storage / the signing store) keyed by a request
 *     id, so a freshly-spawned surface can find the in-flight request.
 *   - A REJOIN PATH: on relaunch the surface re-reads that state and re-parks a
 *     NEW Deferred (the old one is gone); `deliver` must resolve THAT one. The
 *     Promise identity cannot be preserved across processes - only the intent.
 *   - COMPLETION-SIDE IDEMPOTENCY: with teardown possible mid-broadcast, the
 *     resume must tolerate a request whose tx already landed (dedupe on
 *     `coldSendId`/txid) so a rejoin does not double-spend or double-record.
 *   - EXPIRY / GC: parked requests that are never scanned need a TTL so durable
 *     storage does not accumulate dead unsigned sends.
 *
 * None of that is in scope here. This module is the honest in-memory building
 * block; a resumable flow is a strictly larger, separately-designed change.
 *
 * ========================================================================
 *
 * This module is fully self-contained and UNWIRED: nothing imports it yet. It is
 * the target for a LATER zcash-send.tsx migration that will thread this Deferred
 * through the signing surface in place of the hand-rolled
 * build+display / handlePcztSignatureScanned two-phase flow. Migrating touches a
 * working mainnet path, so it is a deliberate, separately-verified step - not
 * done here.
 */

import type { ExternalSigner, SignRequest, SignResult } from './external-signer';

/**
 * The controller returned by {@link createZignerSigner}.
 *
 * INVARIANT (single-shot): a controller drives exactly ONE signing round. The
 * Deferred can be settled at most once; `deliver` and `fail` are both no-ops
 * after the first settle (or after each other). To sign again, create a fresh
 * controller. This mirrors the underlying PCZT round-trip, which is inherently
 * one request -> one signed response.
 */
export interface ZignerSignerController {
  /**
   * The `ExternalSigner` to hand to `signAndBroadcast`. Calling it invokes
   * `display(req)` (once) so the caller can wire AnimatedQrDisplay to the
   * request, then returns a Promise that parks until `deliver` / `fail`.
   *
   * INVARIANT (single-await): the signer may be awaited only once. A second
   * call returns a rejected Promise rather than displaying a second request or
   * silently re-parking, so a re-entrant caller fails loudly instead of leaking
   * a second QR display over the first.
   */
  readonly signer: ExternalSigner;

  /**
   * Resolve the parked Promise with `{ kind: 'signedPczt', pcztHex }`, the form
   * `signAndBroadcast` extracts + broadcasts. Call this from the scan handler
   * once it has reconstructed the fully-signed PCZT hex (device-signed, or with
   * compact contributions already merged host-side).
   *
   * Guarded: a no-op if the round is already settled, or if `deliver` is called
   * BEFORE the signer has been awaited (delivery with nothing parked to receive
   * it is a caller bug, not a signature to buffer). Returns `true` iff this call
   * settled the round.
   */
  deliver(signedPcztHex: string): boolean;

  /**
   * Reject the parked Promise (user cancelled, scan decode failed, response-
   * format mismatch, ...). Guarded identically to `deliver`: a no-op once the
   * round is settled or before the signer is awaited. Returns `true` iff this
   * call settled the round.
   */
  fail(err: unknown): boolean;
}

/**
 * Build a suspended zigner signer over an in-memory Deferred.
 *
 * @param display invoked with the `SignRequest` the first time `signer` runs;
 *   the caller uses it to drive the animated UR display for the air-gapped
 *   device. It must not throw - a throwing `display` rejects the round (the
 *   Promise cannot have been meaningfully displayed).
 *
 * Wiring sketch (for the later migration - NOT active today):
 *
 *   const { signer, deliver, fail } = createZignerSigner(req => {
 *     setPcztSignFrames(buildUrFrames(req.pcztHex));   // display step
 *   });
 *   // on the camera callback, once the signed PCZT is reconstructed:
 *   //   deliver(signedPcztHex);
 *   // on cancel / decode error:
 *   //   fail(reason);
 *   const { txid } = await signAndBroadcast(signer, unsigned, deps);
 */
export function createZignerSigner(display: (req: SignRequest) => void): ZignerSignerController {
  // The Deferred's resolve/reject, captured out of the Promise executor. Null
  // until `signer` is awaited (nothing is parked yet); nulled again on settle
  // so the captured functions cannot be retained past their single use.
  let resolve: ((result: SignResult) => void) | null = null;
  let reject: ((err: unknown) => void) | null = null;

  // `awaited`: the signer has been invoked and a Promise is parked. Distinct
  // from "resolve !== null" only conceptually, but named so the guards read as
  // intent. `settled`: the round has resolved or rejected exactly once.
  let awaited = false;
  let settled = false;

  const signer: ExternalSigner = (req: SignRequest): Promise<SignResult> => {
    // Single-await guard: refuse a second run rather than displaying twice or
    // orphaning the first Promise.
    if (awaited) {
      return Promise.reject(
        new Error('zigner signer already awaited - create a fresh controller per signing round'),
      );
    }
    awaited = true;

    return new Promise<SignResult>((res, rej) => {
      resolve = res;
      reject = rej;

      // Display AFTER capturing resolve/reject, so a synchronous `deliver`
      // fired from inside `display` (unusual, but a scan handler wired eagerly
      // could) still finds the Deferred armed. A throwing `display` means the
      // request never reached the user, so reject the round.
      try {
        display(req);
      } catch (err) {
        settled = true;
        resolve = null;
        reject = null;
        rej(err);
      }
    });
  };

  const deliver = (signedPcztHex: string): boolean => {
    // Guard: already settled, or nothing parked to receive the delivery.
    if (settled || !awaited || !resolve) {
      return false;
    }
    settled = true;
    const res = resolve;
    resolve = null;
    reject = null;
    res({ kind: 'signedPczt', pcztHex: signedPcztHex });
    return true;
  };

  const fail = (err: unknown): boolean => {
    if (settled || !awaited || !reject) {
      return false;
    }
    settled = true;
    const rej = reject;
    resolve = null;
    reject = null;
    rej(err);
    return true;
  };

  return { signer, deliver, fail };
}
