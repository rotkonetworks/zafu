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

/** a handshake failure, as noise-channel tags it. */
const handshakeFailure = (): Error =>
  Object.assign(new Error('noise: expected resp message (0x02)'), { name: 'NoiseHandshakeError' });

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
      'expected resp message',
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

  it("'auto' falls back to classical on a HANDSHAKE failure and labels the downgrade", async () => {
    createNoiseChannel.mockRejectedValueOnce(handshakeFailure());

    const channel = await openChannel(session, 'peer', undefined, 'auto');

    expect(createNoiseChannel).toHaveBeenCalledTimes(1);
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(channel.kind).toBe('classical'); // the caller can SEE the downgrade
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
