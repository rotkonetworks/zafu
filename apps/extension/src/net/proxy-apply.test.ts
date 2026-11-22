import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../offscreen-document', () => ({ ensureOffscreenDocument: vi.fn() }));
vi.mock('../state/encrypted-storage', () => ({ readEncrypted: vi.fn() }));
vi.mock('@repo/storage-chrome/local', () => ({ localExtStorage: {} }));
vi.mock('@repo/storage-chrome/session', () => ({ sessionExtStorage: {} }));

const { startProxy } = await import('./proxy-apply');

const event = () => ({ addListener: vi.fn(), hasListener: vi.fn(() => false) });

/** a worker where a Peer buy granted `webRequest`; `authProvider`: the proxy login permission too */
const chromeWithWebRequestOnly = (authProvider: boolean) => {
  const onAuthRequired = {
    hasListener: vi.fn(() => false),
    addListener: vi.fn((..._args: unknown[]) => {
      if (!authProvider) {
        throw new Error(
          'You do not have permission to use blocking webRequest listeners. Be sure to declare the webRequestBlocking permission in your manifest.',
        );
      }
    }),
  };
  vi.stubGlobal('chrome', {
    webRequest: { onAuthRequired },
    permissions: {
      onAdded: event(),
      onRemoved: event(),
      contains: vi.fn(async () => authProvider),
    },
    storage: {
      onChanged: event(),
      local: { get: vi.fn(async () => ({})), set: vi.fn(), remove: vi.fn() },
    },
  });
  return onAuthRequired;
};

describe('the proxy login listener', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('is not asked for while only webRequest is granted: chrome would log an error each start', async () => {
    const onAuthRequired = chromeWithWebRequestOnly(false);
    // a throw here stopped every listener after it, so passkey requests went unanswered
    expect(() => startProxy()).not.toThrow();
    await vi.waitFor(() => expect(chrome.permissions.contains).toHaveBeenCalled());
    await Promise.resolve();
    expect(onAuthRequired.addListener).not.toHaveBeenCalled();
    expect(chrome.permissions.onAdded.addListener).toHaveBeenCalled();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
  });

  it('listens once the login permission is granted', async () => {
    const onAuthRequired = chromeWithWebRequestOnly(true);
    startProxy();
    await vi.waitFor(() => expect(onAuthRequired.addListener).toHaveBeenCalled());
    expect(onAuthRequired.addListener.mock.calls[0]?.[2]).toEqual(['asyncBlocking']);
  });
});
