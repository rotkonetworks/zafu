import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigateSidePanel } from './side-panel-delivery';

const stubSend = (...answers: (() => Promise<unknown>)[]) => {
  const sendMessage = vi.fn(() => (answers.shift() ?? (() => Promise.resolve(undefined)))());
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return sendMessage;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('navigateSidePanel', () => {
  it('keeps sending until the panel itself acks, so a panel still booting gets the screen', async () => {
    vi.useFakeTimers();
    const send = stubSend(
      () => Promise.reject(new Error('Receiving end does not exist')),
      () => Promise.resolve(undefined), // another listener, not the panel's
      () => Promise.resolve(true),
    );
    const done = navigateSidePanel('/passkey-approve');
    await vi.advanceTimersByTimeAsync(600);
    await expect(done).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('gives up when no panel ever acks, so the caller can open a window', async () => {
    vi.useFakeTimers();
    stubSend();
    const done = navigateSidePanel('/passkey-approve', 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(done).resolves.toBe(false);
  });
});
