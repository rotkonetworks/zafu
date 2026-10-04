import { PenumbraRequestFailure } from '@penumbra-zone/client/error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { sendBackground as SendBackground } from './send-background';
import { ZafuConnection } from './zafu-connection';

// The orphaned-context latch in `utils/reload-notice` is module state, and the
// behaviour under test is that it fires exactly once per document - so each
// test gets a fresh module graph instead of inheriting the latch.
let sendBackground: typeof SendBackground;

beforeEach(async () => {
  vi.resetModules();
  ({ sendBackground } = await import('./send-background'));
});

const stubSendMessage = (impl: () => Promise<unknown>) => {
  const sendMessage = vi.fn(impl);
  vi.stubGlobal('chrome', { runtime: { id: 'zafu', sendMessage } });
  return sendMessage;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.getElementById('zafu-reload-notice')?.remove();
});

describe('sendBackground', () => {
  it('treats a declined request as NotHandled without logging an error', async () => {
    // A listener existed and refused (policy), so sendMessage resolves undefined.
    stubSendMessage(() => Promise.resolve(undefined));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendBackground(ZafuConnection.Load)).resolves.toBe(
      PenumbraRequestFailure.NotHandled,
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('passes through the portal answers the page understands', async () => {
    stubSendMessage(() => Promise.resolve(null));
    await expect(sendBackground(ZafuConnection.Connect)).resolves.toBeNull();

    stubSendMessage(() => Promise.resolve(PenumbraRequestFailure.Denied));
    await expect(sendBackground(ZafuConnection.Connect)).resolves.toBe(
      PenumbraRequestFailure.Denied,
    );

    stubSendMessage(() => Promise.resolve(PenumbraRequestFailure.NeedsLogin));
    await expect(sendBackground(ZafuConnection.Load)).resolves.toBe(
      PenumbraRequestFailure.NeedsLogin,
    );
  });

  it('stays quiet when no receiver is awake', async () => {
    stubSendMessage(() =>
      Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendBackground(ZafuConnection.Connect)).resolves.toBe(
      PenumbraRequestFailure.NotHandled,
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports an unexpected response as BadResponse, loudly', async () => {
    stubSendMessage(() => Promise.resolve({ unexpected: true }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendBackground(ZafuConnection.Connect)).resolves.toBe(
      PenumbraRequestFailure.BadResponse,
    );
    expect(consoleError).toHaveBeenCalled();
  });

  it('asks the user to reload when the extension context is orphaned', async () => {
    stubSendMessage(() => Promise.reject(new Error('Extension context invalidated.')));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(sendBackground(ZafuConnection.Load)).resolves.toBe(
      PenumbraRequestFailure.NotHandled,
    );
    expect(document.getElementById('zafu-reload-notice')).not.toBeNull();
  });

  it('stays quiet when an orphaned page pokes it again', async () => {
    stubSendMessage(() => Promise.reject(new Error('Extension context invalidated.')));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // A page whose listeners are still bound keeps poking; each poke used to
    // log an error. Only the first detection may speak.
    await sendBackground(ZafuConnection.Load);
    await sendBackground(ZafuConnection.Connect);
    await sendBackground(ZafuConnection.Load);

    expect(consoleError).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('#zafu-reload-notice')).toHaveLength(1);
  });
});

describe('sendBackground with chrome.runtime gone', () => {
  it('shows the reload notice once and never calls into the dead runtime', async () => {
    vi.stubGlobal('chrome', {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(sendBackground(ZafuConnection.Load)).resolves.toBe(
      PenumbraRequestFailure.BadResponse,
    );
    await sendBackground(ZafuConnection.Load);
    expect(consoleError).not.toHaveBeenCalled();
    expect(document.getElementById('zafu-reload-notice')).not.toBeNull();
  });
});
