/**
 * zid as Services and Filters (Eriksen, "Your Server as a Function"; see
 * docs/services-pattern.md - the repo's one convention, so this extends it
 * rather than inventing a dialect).
 *
 * A `Service` is a request-to-response function; a `Filter` is `(Service) =>
 * Service`. Nothing here is a new abstraction - it is how the zid seams compose:
 *
 *   - `walletService`  : one zafu wallet request -> its response (the I/O leaf)
 *   - `channelService` : one frame handed to a ZidChannel
 *   - `sealingFilter`  : seal the request to a peer, open their sealed response
 *   - `walletStrategy` : named, pre-composed filter stack around the wallet
 *
 * The encrypted request path is then a composition, not a bespoke function:
 *
 *   const relayService: Service<Uint8Array, Uint8Array> = ...   // caller's leaf
 *   const encrypted = compose(
 *     trace({ onComplete: log }),
 *     timeout(5_000),
 *     sealingFilter(keys),
 *     retry({ attempts: 3 }),
 *   )(relayService);
 *
 * `compose` is left-to-right with the first-listed filter OUTERMOST, matching
 * `apps/extension/src/signing/external-signer.ts`.
 */

import {
  compose,
  retry,
  timeout,
  trace,
  type Filter,
  type Service,
  type ServiceContext,
  type ServiceFilter,
  type TraceEvent,
} from '@zafu/service';
import type { ZafuRequest, ZafuResponse, ZafuTransport } from '@zafu/protocol';
import { openXWing, sealXWing } from '@zafu/pq';
import type { ZidChannel } from './types';

/** every zafu request the wallet service can carry (the union over ZafuApi). */
export type WalletRequest = ZafuRequest;
/** the matching response union. */
export type WalletResponse = ZafuResponse;

/**
 * The wallet as a Service: one request in, that request's response out. This is
 * the only I/O leaf for the wallet path - filters wrap it, never reimplement it.
 *
 * CANCELLATION LIMITATION (honest, not silent): `ZafuTransport.request` takes no
 * signal, so an abort handed in through `ctx.signal` cannot reach the extension
 * bridge. We honour it BEFORE the call and reject if already aborted, but an
 * in-flight `chrome.runtime.sendMessage` is NOT cancelled - `timeout` bounds the
 * CALLER (it fails with `TimeoutError` at the deadline) while the wallet call
 * may still complete in the background. Wiring real cancellation needs the
 * transport to accept `ZafuTransportCallOptions`.
 */
export function walletService(transport: ZafuTransport): Service<WalletRequest, WalletResponse> {
  return async (req, ctx) => {
    if (ctx.signal?.aborted) {
      throw ctx.signal.reason ?? new Error('aborted');
    }
    return transport.request(req.type, req);
  };
}

/** the named wallet strategies - the closed union callers bind to. */
export type WalletStrategyName = 'default' | 'patient';

export interface WalletStrategyOptions {
  /** observe each call (duration, outcome); omit for the no-op default. */
  onTrace?: (event: TraceEvent) => void;
}

/**
 * A named, pre-composed filter stack around a wallet service. `default` bounds a
 * single prompt-interactive call; `patient` allows for a slow approval (longer
 * deadline, a few retries with backoff). Filters never touch request/response
 * shapes, so either stack drops onto any `Service<WalletRequest, WalletResponse>`.
 */
export function walletStrategy(
  name: WalletStrategyName,
  opts: WalletStrategyOptions = {},
): ServiceFilter {
  const spec =
    name === 'patient'
      ? { timeoutMs: 30_000, attempts: 3, backoffMs: 250 }
      : { timeoutMs: 10_000, attempts: 2, backoffMs: 0 };
  return compose(
    trace({ onComplete: opts.onTrace ?? (() => undefined) }),
    timeout(spec.timeoutMs),
    retry({ attempts: spec.attempts, backoffMs: spec.backoffMs }),
  );
}

/**
 * Sending on a ZidChannel as a Service.
 *
 * DELIVERY SEMANTICS: `ZidChannel.send` is void fire-and-forget and `on` has no
 * unsubscribe, so the returned promise resolves when the frame is HANDED to the
 * transport - not when the peer receives it. There is no delivery ack and no
 * backpressure to await; a filter wrapping this can bound the hand-off, not the
 * leg across the wire.
 */
export function channelService(channel: ZidChannel): Service<Uint8Array, void> {
  return async frame => {
    channel.send(frame);
  };
}

/** the X-Wing keys a sealing filter needs: the peer's public key, our own seed. */
export interface SealingKeys {
  /** peer's X-Wing encapsulation key (1216 bytes) - the request is sealed to it. */
  recipientPublicKey: Uint8Array;
  /** our own X-Wing seed (32 bytes) - opens the sealed response. */
  selfSeed: Uint8Array;
}

/**
 * A filter that makes any byte `Service` an end-to-end encrypted request path:
 * seal the plaintext request with `sealXWing` to the peer, call the inner
 * service with the sealed bytes, then `openXWing` their sealed response with our
 * own seed. The inner service sees ciphertext only, so it can be a dumb relay -
 * and a recorder of the wire learns nothing.
 *
 * It is BYTE-SHAPED (only meaningful against a `Service<Uint8Array, Uint8Array>`)
 * but declares the polymorphic `ServiceFilter` type so it drops straight into
 * `compose` beside the shape-agnostic filters:
 *
 *   compose(trace(...), timeout(5_000), sealingFilter(keys), retry(...))(relayService)
 *
 * `keys.recipientPublicKey` / `keys.selfSeed` are raw X-Wing material (from
 * `@zafu/pq`), not the hex forms a contact card carries.
 */
export function sealingFilter(keys: SealingKeys): ServiceFilter {
  const byteFilter: Filter<Uint8Array, Uint8Array> = inner => async (req, ctx) => {
    const sealed = sealXWing(keys.recipientPublicKey, req);
    return openXWing(keys.selfSeed, await inner(sealed, ctx));
  };
  return <Req, Res, Ctx extends ServiceContext>(inner: Service<Req, Res, Ctx>) =>
    byteFilter(inner as unknown as Service<Uint8Array, Uint8Array>) as unknown as Service<
      Req,
      Res,
      Ctx
    >;
}
