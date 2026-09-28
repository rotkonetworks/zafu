import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { init, end } = vi.hoisted(() => ({ init: vi.fn(), end: vi.fn() }));

vi.mock('@penumbra-zone/transport-chrome/session-client', () => ({
  CRSessionClient: { init, end },
}));

// clients.ts caches the session port in module scope, so each test needs a fresh
// module instance; the specifier is fixed but the module graph must be reloaded.
const loadGetOrCreatePort = async () => (await import('./clients')).getOrCreatePort;

beforeEach(() => {
  vi.resetModules();
  init.mockReset();
  end.mockReset();
});

afterEach(() => {
  document.getElementById('zafu-reload-notice')?.remove();
});

describe('getOrCreatePort', () => {
  it('creates the session port once and reuses it', async () => {
    const port = new MessageChannel().port1;
    init.mockReturnValue(port);
    const getOrCreatePort = await loadGetOrCreatePort();

    await expect(getOrCreatePort()).resolves.toBe(port);
    await expect(getOrCreatePort()).resolves.toBe(port);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(chrome.runtime.id);
  });

  it('caches a dead-context failure instead of retrying it per request', async () => {
    init.mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    const getOrCreatePort = await loadGetOrCreatePort();

    await expect(getOrCreatePort()).rejects.toThrow('Extension context invalidated.');
    expect(document.getElementById('zafu-reload-notice')).not.toBeNull();

    await expect(getOrCreatePort()).rejects.toThrow('Extension context invalidated.');
    expect(init).toHaveBeenCalledTimes(1);
  });

  // The pagehide cases run last: each import registers a window listener that
  // outlives its module instance, and only the modules above ever hold a port.
  it('releases the session port when the page is hidden and kept', async () => {
    const first = new MessageChannel().port1;
    const second = new MessageChannel().port1;
    init.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const getOrCreatePort = await loadGetOrCreatePort();

    await expect(getOrCreatePort()).resolves.toBe(first);
    end.mockClear();

    // a page that goes away must not keep its port: Chromium reports an
    // unchecked runtime.lastError for a port held across the back/forward cache
    window.dispatchEvent(new Event('pagehide'));

    expect(end).toHaveBeenCalledWith(chrome.runtime.id);
    // and the restored document re-inits lazily, without an explicit notice
    await expect(getOrCreatePort()).resolves.toBe(second);
    expect(init).toHaveBeenCalledTimes(2);
  });

  it('never ends a session that was not opened', async () => {
    await loadGetOrCreatePort();
    // drain any session a listener from an earlier import still holds
    window.dispatchEvent(new Event('pagehide'));
    end.mockClear();

    window.dispatchEvent(new Event('pagehide'));

    // `CRSessionClient.end` throws for an unknown manager id
    expect(end).not.toHaveBeenCalled();
  });
});
