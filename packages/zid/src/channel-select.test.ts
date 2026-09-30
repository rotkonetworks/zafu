import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openChannel } from './channel-select';
import type { SessionKey } from './noise-channel';
import type { ZidChannel } from './types';

const { createNoiseChannel, createChannel, isNoiseHandshakeFailure } = vi.hoisted(() => ({
  createNoiseChannel: vi.fn(),
  createChannel: vi.fn(),
  // mirrors noise-channel's name-based tagging (pinned for real in
  // noise-channel.test.ts); the mock must expose it because openChannel imports it.
  isNoiseHandshakeFailure: (e: unknown): boolean =>
    e instanceof Error && e.name === 'NoiseHandshakeError',
}));
vi.mock('./noise-channel', () => ({ createNoiseChannel, isNoiseHandshakeFailure }));
vi.mock('./channel', () => ({ createChannel }));

const session: SessionKey = {
  pubkey: 'aa'.repeat(32),
  privkey: new Uint8Array(32),
  sign: async () => '00',
};

const fakeChannel: ZidChannel = {
  peer: 'peer',
  send: () => {},
  on: () => {},
  close: () => {},
};

/** a genuine capability signal: the peer's well-formed refusal naming its protocol. */
const handshakeFailure = (): Error =>
  Object.assign(
    new Error('noise: peer does not support zafuNoise_IKhybrid...; it offered classical'),
    {
      name: 'NoiseHandshakeError',
    },
  );

/** a malformed/truncated peer frame - a TRANSPORT failure, NOT a downgrade signal. */
const malformedFailure = (): Error =>
  Object.assign(new Error('noise: resp message too short (100 < 1137)'), {
    name: 'NoiseMalformedMessageError',
  });

/** the handshake deadline - also a TRANSPORT failure, NOT a downgrade signal. */
const timeoutFailure = (): Error =>
  Object.assign(new Error('noise: hybrid handshake timed out after 15000ms'), {
    name: 'NoiseHandshakeTimeoutError',
  });

/** a transport failure - the relay is down, the socket errored. NOT tagged. */
const transportFailure = (): Error => new Error('noise: connection closed during handshake');

beforeEach(() => {
  createNoiseChannel.mockReset();
  createChannel.mockReset();
  createNoiseChannel.mockResolvedValue(fakeChannel);
  createChannel.mockResolvedValue(fakeChannel);
});

describe('channel mode selection', () => {
  it("defaults to 'hybrid'", async () => {
    const channel = await openChannel(session, 'peer', undefined);

    expect(createNoiseChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).not.toHaveBeenCalled();
    expect(channel.kind).toBe('hybrid');
  });

  it("'hybrid' fails closed - it does NOT fall back when the handshake fails", async () => {
    createNoiseChannel.mockRejectedValueOnce(handshakeFailure());

    await expect(openChannel(session, 'peer', undefined, 'hybrid')).rejects.toThrow(
      'peer does not support',
    );
    expect(createNoiseChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).not.toHaveBeenCalled();
  });

  it("'classical' opens the legacy channel and labels it", async () => {
    const channel = await openChannel(session, 'peer', undefined, 'classical');

    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(createNoiseChannel).not.toHaveBeenCalled();
    expect(channel.kind).toBe('classical');
  });

  it("'auto' downgrades only on the well-formed capability refusal, and labels it", async () => {
    createNoiseChannel.mockRejectedValueOnce(handshakeFailure());

    const channel = await openChannel(session, 'peer', undefined, 'auto');

    expect(createNoiseChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(channel.kind).toBe('classical'); // the caller can SEE the downgrade
  });

  it("'auto' does NOT downgrade on a malformed/short responder frame - it propagates", async () => {
    createNoiseChannel.mockRejectedValueOnce(malformedFailure());

    await expect(openChannel(session, 'peer', undefined, 'auto')).rejects.toThrow(/too short/);
    expect(createNoiseChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).not.toHaveBeenCalled(); // a crafted frame never forces classical
  });

  it("'auto' does NOT downgrade on a handshake timeout - it propagates", async () => {
    createNoiseChannel.mockRejectedValueOnce(timeoutFailure());

    await expect(openChannel(session, 'peer', undefined, 'auto')).rejects.toThrow(/timed out/);
    expect(createNoiseChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).not.toHaveBeenCalled();
  });

  it("'auto' does NOT fall back on a transport failure - it propagates", async () => {
    createNoiseChannel.mockRejectedValueOnce(transportFailure());

    await expect(openChannel(session, 'peer', undefined, 'auto')).rejects.toThrow(
      'connection closed',
    );
    expect(createNoiseChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).not.toHaveBeenCalled(); // the classical path was never tried
  });

  it("'auto' does not fall back when the hybrid handshake succeeds", async () => {
    const channel = await openChannel(session, 'peer', undefined, 'auto');

    expect(createNoiseChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).not.toHaveBeenCalled();
    expect(channel.kind).toBe('hybrid');
  });
});
