import { beforeEach, describe, expect, it, vi } from 'vitest';

type L = (req: unknown, sender: unknown, respond: (r?: unknown) => void) => unknown;

/** a chrome whose events remember their listeners, and the module loaded fresh against it */
const load = async () => {
  vi.resetModules();
  const registered: L[] = [];
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: (l: L) => registered.push(l) },
      onMessageExternal: { addListener: vi.fn() },
    },
  });
  const early = await import('./early-messages');
  /** deliver as Chrome does: every listener is called; true keeps the channel open */
  const deliver = (req: unknown) => {
    const respond = vi.fn();
    const kept = registered.map(l => l(req, {}, respond) === true).includes(true);
    return { respond, kept };
  };
  return { early, deliver };
};

describe('messages that arrive before the listeners', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('a message that woke the worker waits, then reaches the listener registered after it', async () => {
    const { early, deliver } = await load();
    const woke = deliver({ type: 'zafu_passkey_get' });
    expect(woke.kept).toBe(true); // the channel stays open, nothing answered yet
    expect(woke.respond).not.toHaveBeenCalled();

    early.listen((req, _sender, respond) => {
      if ((req as { type: string }).type !== 'zafu_passkey_get') {
        return false;
      }
      setTimeout(() => respond({ success: true }), 0);
      return true;
    });
    early.releaseHeldMessages();
    await new Promise(r => setTimeout(r, 5));
    expect(woke.respond).toHaveBeenCalledWith({ success: true });
  });

  it('a held message no listener takes is answered with nothing, not left open', async () => {
    const { early, deliver } = await load();
    const stray = deliver({ type: 'unknown' });
    early.listen(() => false);
    early.releaseHeldMessages();
    expect(stray.respond).toHaveBeenCalledTimes(1);
    expect(stray.respond).toHaveBeenCalledWith(undefined);
  });

  it('after the release it steps aside: listeners get messages straight from chrome', async () => {
    const { early, deliver } = await load();
    const seen: unknown[] = [];
    early.listen(req => {
      seen.push(req);
      return false;
    });
    early.releaseHeldMessages();
    const later = deliver('later');
    expect(seen).toEqual(['later']);
    expect(later.kept).toBe(false);
  });
});
