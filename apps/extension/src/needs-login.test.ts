import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { session, openApprovalPopup } = vi.hoisted(() => {
  // needs-login resolves its popup url when it loads
  (globalThis.chrome.runtime as unknown as { getURL: unknown }).getURL = (p: string) =>
    `chrome-extension://test${p}`;
  return {
    session: { passwordKey: undefined as string | undefined },
    openApprovalPopup: vi.fn(async () => ({ id: 7 })),
  };
});
vi.mock('@repo/storage-chrome/session', () => ({
  sessionExtStorage: { get: vi.fn(async () => session.passwordKey) },
}));
vi.mock('./utils/popup-window', () => ({ openApprovalPopup }));
vi.mock('./side-panel-presence', () => ({ isSidePanelOpen: async () => false }));
vi.mock('./side-panel-pref', () => ({ getApprovalSurface: async () => 'popup' }));

import { throwIfNeedsLogin } from './needs-login';

/** the person closes the login window without unlocking */
const dismissed = () => {
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    get: vi.fn(async () => {
      throw new Error('closed');
    }),
    getLastFocused: vi.fn(async () => ({ id: 1 })),
    remove: vi.fn(async () => undefined),
  };
};

describe('a dismissed unlock makes that site wait', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    session.passwordKey = undefined;
    openApprovalPopup.mockClear();
    dismissed();
  });
  afterEach(() => vi.useRealTimers());

  it('a looping site gets one prompt, then waits; another site still may ask', async () => {
    await expect(throwIfNeedsLogin('https://loop.example')).rejects.toThrow();
    await expect(throwIfNeedsLogin('https://loop.example')).rejects.toThrow();
    expect(openApprovalPopup).toHaveBeenCalledTimes(1);

    await expect(throwIfNeedsLogin('https://other.example')).rejects.toThrow();
    expect(openApprovalPopup).toHaveBeenCalledTimes(2);
  });

  it('the wait ends, and doubles after the next dismissal', async () => {
    const origin = 'https://again.example';
    await expect(throwIfNeedsLogin(origin)).rejects.toThrow();
    vi.advanceTimersByTime(30_001);
    await expect(throwIfNeedsLogin(origin)).rejects.toThrow();
    expect(openApprovalPopup).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_001);
    await expect(throwIfNeedsLogin(origin)).rejects.toThrow();
    expect(openApprovalPopup).toHaveBeenCalledTimes(2);
  });

  it('unlocking zafu ends every wait', async () => {
    const origin = 'https://after-unlock.example';
    await expect(throwIfNeedsLogin(origin)).rejects.toThrow();
    session.passwordKey = 'key';
    await throwIfNeedsLogin(origin);
    session.passwordKey = undefined;
    await expect(throwIfNeedsLogin(origin)).rejects.toThrow();
    expect(openApprovalPopup).toHaveBeenCalledTimes(2);
  });
});
