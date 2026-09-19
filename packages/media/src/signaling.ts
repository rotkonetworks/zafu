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
