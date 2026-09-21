/**
 * Pluggable signaling transport for the media session.
 *
 * The call only needs to move two kinds of tiny control messages to the peer -
 * SDP descriptions and ICE candidates. It does NOT care how they travel. The
 * host app injects a `Signaling` and thereby chooses the transport:
 *
 *   - zitadel: over a `@zafu/zid` Noise channel (see zidSignaling) - so call
 *     setup is itself end-to-end, post-quantum encrypted.
 *   - poker: over its existing encrypted blind relay.
 *
 * Media (the audio/video RTP) never flows through here - it is direct P2P once
 * ICE connects. Only offer/answer/candidate setup rides this channel.
 */

import {
  compose,
  timeout,
  trace,
  type Service,
  type ServiceFilter,
  type TraceEvent,
} from '@zafu/service';

export type MediaSignal =
  | { t: '_sdp'; d: { sdp: RTCSessionDescriptionInit } }
  | { t: '_ice'; d: { candidate: RTCIceCandidateInit } };

export interface Signaling {
  /** Send a control message to the single remote peer. */
  send(msg: MediaSignal): void;
  /** Register the inbound handler. Returns an unsubscribe function. */
  onSignal(handler: (msg: MediaSignal) => void): () => void;
}

/** A `@zafu/zid`-style encrypted channel: send bytes, receive bytes. */
export interface ByteChannel {
  send(data: string | Uint8Array): void;
  on(event: 'message', handler: (data: Uint8Array) => void): void;
}

/**
 * Bridge a `@zafu/zid` ZidChannel (or any ByteChannel) into `Signaling`, so
 * SDP/ICE ride the same E2EE channel as the DMs. Messages are JSON, framed with
 * a 1-byte tag so media control never collides with the app's own chat frames.
 *
 * @param tag byte prefix distinguishing media-signal frames (default 0xF0).
 */
export function zidSignaling(channel: ByteChannel, tag = 0xf0): Signaling {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const handlers = new Set<(msg: MediaSignal) => void>();

  channel.on('message', data => {
    if (data[0] !== tag) {
      return; // not a media-signal frame - leave it for the app's own handler
    }
    try {
      const msg = JSON.parse(dec.decode(data.subarray(1))) as MediaSignal;
      for (const h of handlers) {
        h(msg);
      }
    } catch {
      // malformed frame - ignore rather than throw into the socket handler
    }
  });

  return {
    send(msg: MediaSignal): void {
      const body = enc.encode(JSON.stringify(msg));
      const framed = new Uint8Array(body.length + 1);
      framed[0] = tag;
      framed.set(body, 1);
      channel.send(framed);
    },
    onSignal(handler: (msg: MediaSignal) => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Services pattern - so a call can ride ANY Service
// ---------------------------------------------------------------------------
//
// docs/services-pattern.md is the repo's one composition convention. These two
// adapters put signaling on both sides of it, so SDP/ICE can ride whatever
// Service the app already has (a sealed relay, a retrying transport, ...).

/** registers an inbound handler; returns its unsubscribe. */
export type SignalSubscriber = (handler: (msg: MediaSignal) => void) => () => void;

/**
 * Outbound signaling as a Service: one signal in, sent to the peer. Wrap it in
 * filters (`signalingStrategy`) to bound or observe the hand-off.
 *
 * Delivery semantics are the transport's: `Signaling.send` is void, so the
 * promise resolves when the signal is HANDED to the transport, not when the peer
 * receives it.
 */
export function callSignalService(signaling: Signaling): Service<MediaSignal, void> {
  return async msg => {
    signaling.send(msg);
  };
}

/**
 * Inbound signaling as the `subscribe` half of a `Signaling`, paired with a
 * Service for the outbound half. A Service is one-way, so the source of inbound
 * signals is injected: pass whatever registers a handler and returns an
 * unsubscribe (a socket, a channel, an event emitter).
 *
 * `Signaling.send` returns void, so a rejected outbound service has nowhere to
 * report - the rejection is dropped here. Use `callSignalService` directly when
 * you need the promise (and filters around it).
 */
export function serviceSignaling(
  service: Service<MediaSignal, void>,
  subscribe: SignalSubscriber,
): Signaling {
  return {
    send(msg: MediaSignal): void {
      void service(msg, {}).catch(() => {});
    },
    onSignal(handler: (msg: MediaSignal) => void): () => void {
      return subscribe(handler);
    },
  };
}

/** the named signaling strategies - the closed union callers bind to. */
export type SignalingStrategyName = 'default' | 'patient';

export interface SignalingStrategyOptions {
  /** observe each send (duration, outcome); omit for the no-op default. */
  onTrace?: (event: TraceEvent) => void;
}

/**
 * A named, pre-composed filter stack for the outbound signal service.
 *
 * Deliberately no retry: re-sending an SDP/ICE frame can duplicate or reorder a
 * negotiation step, and perfect negotiation is order-sensitive - so a send is
 * bounded (timeout) and observed (trace), never replayed.
 */
export function signalingStrategy(
  name: SignalingStrategyName,
  opts: SignalingStrategyOptions = {},
): ServiceFilter {
  const timeoutMs = name === 'patient' ? 10_000 : 2_000;
  return compose(trace({ onComplete: opts.onTrace ?? (() => undefined) }), timeout(timeoutMs));
}
