import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isContextInvalidated } from './reload-notice';

const setup = async () => {
  const handlers: Record<string, (e: unknown) => void> = {};
  const spy = vi.spyOn(globalThis, 'addEventListener').mockImplementation(((
    type: string,
    cb: (e: unknown) => void,
  ) => {
    handlers[type] = cb;
  }) as never);
  const { installGracefulNetworkErrorHandler } = await import('./graceful-network-errors');
  installGracefulNetworkErrorHandler();
  spy.mockRestore();
  return handlers;
};

afterEach(() => {
  document.getElementById('zafu-reload-notice')?.remove();
});

describe('isContextInvalidated', () => {
  it('finds the orphaned-context signal through a wrapped cause chain', () => {
    const wrapped = new Error('Connection request failed', {
      cause: new Error('Extension context invalidated.'),
    });
    expect(isContextInvalidated(wrapped)).toBe(true);
    expect(isContextInvalidated(new Error('Extension context invalidated.'))).toBe(true);
  });

  it('does not mistake other errors for an orphaned context', () => {
    expect(isContextInvalidated(new Error('Extension context invalidated'))).toBe(true);
    expect(isContextInvalidated(new Error('network error'))).toBe(false);
    expect(isContextInvalidated(undefined)).toBe(false);
  });
});

describe('installGracefulNetworkErrorHandler', () => {
  // The invalidation latch is module state and is deliberately one-shot, so a
  // fresh module graph per test mirrors a fresh document.
  beforeEach(() => {
    vi.resetModules();
  });

  it('turns an orphaned extension context into a reload notice instead of a storm', async () => {
    const handlers = await setup();
    const preventDefault = vi.fn();

    handlers['unhandledrejection']?.({
      reason: new Error('Extension context invalidated.'),
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalled();
    const notice = document.getElementById('zafu-reload-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('reload');
  });

  it('also handles the orphaned context reported through an error event', async () => {
    const handlers = await setup();
    const preventDefault = vi.fn();

    handlers['error']?.({
      error: new Error('Extension context invalidated.'),
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(document.getElementById('zafu-reload-notice')).not.toBeNull();
  });

  it('leaves genuine failures untouched', async () => {
    const handlers = await setup();
    const preventDefault = vi.fn();

    handlers['unhandledrejection']?.({ reason: new Error('boom'), preventDefault });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(document.getElementById('zafu-reload-notice')).toBeNull();
  });

  it('treats any Sync stop reason as benign, not just wallet switch', async () => {
    const handlers = await setup();
    const preventDefault = vi.fn();

    handlers['unhandledrejection']?.({
      reason: new Error('Sync stop network switch'),
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalled();
  });

  it('treats an egress refusal as benign even wrapped in a ConnectError', async () => {
    const { EgressBlockedError } = await import('../net/egress');
    const handlers = await setup();
    const preventDefault = vi.fn();
    const refusal = { allow: false, host: 'api.coingecko.com', destination: 'other' } as const;

    handlers['unhandledrejection']?.({
      reason: new Error('[unknown] network error', {
        cause: new EgressBlockedError(refusal as never),
      }),
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalled();
  });
});
