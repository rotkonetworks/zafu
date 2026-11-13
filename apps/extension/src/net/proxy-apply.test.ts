import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../offscreen-document', () => ({ ensureOffscreenDocument: vi.fn() }));
vi.mock('../state/encrypted-storage', () => ({ readEncrypted: vi.fn() }));
vi.mock('@repo/storage-chrome/local', () => ({ localExtStorage: {} }));
vi.mock('@repo/storage-chrome/session', () => ({ sessionExtStorage: {} }));

const { startProxy } = await import('./proxy-apply');

const event = () => ({ addListener: vi.fn(), hasListener: vi.fn(() => false) });

/** a worker where a Peer buy granted `webRequest` but not `webRequestAuthProvider` */
const chromeWithWebRequestOnly = () => {
  const onAuthRequired = {
    hasListener: vi.fn(() => false),
    addListener: vi.fn(() => {
      throw new Error(
        'You do not have permission to use blocking webRequest listeners. Be sure to declare the webRequestBlocking permission in your manifest.',
      );
    }),
  };
  vi.stubGlobal('chrome', {
    webRequest: { onAuthRequired },
    permissions: { onAdded: event(), onRemoved: event() },
    storage: {
      onChanged: event(),
      local: { get: vi.fn(async () => ({})), set: vi.fn(), remove: vi.fn() },
    },
  });
  return onAuthRequired;
};

describe('the proxy login listener', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('never throws out of the worker start when only webRequest is granted', () => {
    const onAuthRequired = chromeWithWebRequestOnly();
    // a throw here stopped every listener after it, so passkey requests went unanswered
    expect(() => startProxy()).not.toThrow();
    expect(onAuthRequired.addListener).toHaveBeenCalled();
    expect(chrome.permissions.onAdded.addListener).toHaveBeenCalled();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
  });
});
