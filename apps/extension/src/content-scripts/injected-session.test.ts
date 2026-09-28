import { afterEach, describe, expect, test, vi } from 'vitest';
import { ZafuControl } from './message/zafu-control';

/**
 * The content-script bridge opens a persistent extension port (`CRSessionClient`)
 * when a page connects. A page that navigates away never sends
 * `ZafuControl.End`, so without an explicit teardown the port outlives the
 * navigation - Chromium then reports an unchecked runtime.lastError once the
 * page is moved into the back/forward cache, and the session stays attached to a
 * frozen document. `CRSessionClient.end` throws on a manager id it never
 * serviced, so the teardown must only fire for a session the bridge opened.
 */

const end = vi.fn();
const init = vi.fn(() => new MessageChannel().port1);

vi.mock('@penumbra-zone/transport-chrome/session-client', () => ({
  CRSessionClient: {
    init: (...args: unknown[]) => init(...(args as [])),
    end: (...args: unknown[]) => end(...(args as [])),
  },
}));

// the shared mock-chrome runtime has no onMessage; send-background registers there
type BackgroundListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: null) => void,
) => boolean;
const backgroundListeners: BackgroundListener[] = [];
vi.stubGlobal('chrome', {
  runtime: {
    id: 'test-extension-id',
    onMessage: {
      addListener: (l: BackgroundListener) => void backgroundListeners.push(l),
      removeListener: vi.fn(),
    },
  },
});

afterEach(() => {
  end.mockClear();
  init.mockClear();
  backgroundListeners.length = 0;
  vi.resetModules();
});

const sender = { id: 'test-extension-id' } as chrome.runtime.MessageSender;

const importBridge = async () => {
  await import('./injected-session');
  const listener = backgroundListeners[0];
  return (message: ZafuControl) => listener(message, sender, () => {});
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('injected-session page teardown', () => {
  test('releases the session port when a connected page goes away', async () => {
    const listener = await importBridge();
    listener(ZafuControl.Init);
    await settle();
    expect(init).toHaveBeenCalledWith('test-extension-id');
    expect(end).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pagehide'));

    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith('test-extension-id');
    // and the teardown is one-shot: a second unload must not end twice
    window.dispatchEvent(new Event('pagehide'));
    expect(end).toHaveBeenCalledTimes(1);
  });

  test('does not touch the session client for a page that never connected', async () => {
    await importBridge();

    window.dispatchEvent(new Event('pagehide'));

    // `CRSessionClient.end` throws when no session was initialized
    expect(end).not.toHaveBeenCalled();
  });

  test('does not release a session the page already ended', async () => {
    const listener = await importBridge();
    listener(ZafuControl.Init);
    listener(ZafuControl.End);
    end.mockClear();

    window.dispatchEvent(new Event('pagehide'));

    expect(end).not.toHaveBeenCalled();
  });
});

/**
 * This script is the only bridge between the ISOLATED world (which owns
 * `chrome.runtime.id`) and the MAIN-world script (which has no chrome access).
 * The id crosses as a plain DOM attribute rather than through `dataset`, because
 * `dataset` only exists on HTMLElement/SVGElement: on a non-HTML document (a
 * top-level `.xml`/`.svg` response) writing `documentElement.dataset` throws an
 * uncaught TypeError that kills the script before it can do anything else.
 */
describe('injected-session bridge attribute', () => {
  const stubDocument = (documentElement: unknown) => {
    vi.stubGlobal('document', { documentElement: documentElement ?? null });
  };

  test('publishes the extension id as a plain attribute on a root without dataset', async () => {
    const root = { setAttribute: vi.fn() };
    expect('dataset' in root).toBe(false);
    stubDocument(root);

    await import('./injected-session');

    expect(root.setAttribute).toHaveBeenCalledWith('data-zafu-extension-id', 'test-extension-id');
  });

  test('survives a document with no documentElement', async () => {
    stubDocument(null);

    await expect(import('./injected-session')).resolves.toBeDefined();
  });
});
