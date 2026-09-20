import { describe, it, expect } from 'vitest';
import { zidSignaling, type ByteChannel, type MediaSignal } from './signaling';

/**
 * Stand-in for a @zafu/zid channel: records outbound frames and lets the test
 * inject inbound ones, so both directions of the bridge are testable without a
 * wallet or a socket.
 */
function fakeChannel() {
  const sent: Uint8Array[] = [];
  const handlers = new Set<(data: Uint8Array) => void>();
  const channel: ByteChannel = {
    send: data => {
      sent.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
    },
    on: (_event, handler) => {
      handlers.add(handler);
    },
  };
  return { channel, sent, inbound: (data: Uint8Array) => handlers.forEach(h => h(data)) };
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const ICE: MediaSignal = {
  t: '_ice',
  d: { candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0' } },
};

describe('zidSignaling - SDP/ICE over an encrypted byte channel', () => {
  it('frames a signal behind the tag byte and delivers it to the peer handler', () => {
    const { channel, sent, inbound } = fakeChannel();
    const mine = zidSignaling(channel);
    const theirs = zidSignaling(channel);
    const got: MediaSignal[] = [];
    theirs.onSignal(m => got.push(m));

    mine.send(ICE);

    expect(sent[0]![0]).toBe(0xf0);
    expect(JSON.parse(new TextDecoder().decode(sent[0]!.subarray(1)))).toEqual(ICE);

    inbound(sent[0]!);
    expect(got).toEqual([ICE]);
  });

  it("leaves the app's own frames alone", () => {
    const { channel, inbound } = fakeChannel();
    const got: MediaSignal[] = [];
    zidSignaling(channel).onSignal(m => got.push(m));

    inbound(utf8('normal chat frame')); // first byte is 'n', not the tag

    expect(got).toEqual([]);
  });

  it('drops a malformed frame instead of throwing into the socket handler', () => {
    const { channel, inbound } = fakeChannel();
    const got: MediaSignal[] = [];
    zidSignaling(channel).onSignal(m => got.push(m));
    const malformed = new Uint8Array([0xf0, ...utf8('{not json')]);

    expect(() => inbound(malformed)).not.toThrow();
    expect(got).toEqual([]);
  });

  it('honours a custom tag and ignores frames under other tags', () => {
    const { channel, sent, inbound } = fakeChannel();
    const mine = zidSignaling(channel, 0x42);
    const got: MediaSignal[] = [];
    mine.onSignal(m => got.push(m));

    mine.send(ICE);
    expect(sent[0]![0]).toBe(0x42);
    expect(() => inbound(sent[0]!)).not.toThrow();
    expect(got).toEqual([ICE]);

    const underDefaultTag = new Uint8Array([0xf0, ...utf8(JSON.stringify(ICE))]);
    inbound(underDefaultTag);
    expect(got).toEqual([ICE]); // unchanged - another media channel's traffic
  });

  it('unsubscribing stops delivery', () => {
    const { channel, sent, inbound } = fakeChannel();
    const sender = zidSignaling(channel);
    const receiver = zidSignaling(channel);
    const got: MediaSignal[] = [];
    const stop = receiver.onSignal(m => got.push(m));

    sender.send(ICE);
    stop();
    inbound(sent[0]!);

    expect(got).toEqual([]);
  });
});
