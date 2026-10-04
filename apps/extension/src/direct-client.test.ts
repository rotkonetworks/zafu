import { describe, expect, it, vi } from 'vitest';
import { directGetPort } from './direct-client';

const until = (f: () => boolean) => vi.waitFor(() => expect(f()).toBe(true));

describe('direct client port', () => {
  it('passes a caller abort to the running call, quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let seen: AbortSignal | undefined;
    const entry = vi.fn((_req: unknown, signal?: AbortSignal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    });
    const port = await directGetPort(entry as never, undefined)();
    port.postMessage({ requestId: 'a', message: {} });
    await until(() => !!seen);
    port.postMessage({ requestId: 'a', abort: true });
    await until(() => !!seen?.aborted);
    expect(warn).not.toHaveBeenCalled();
    port.close();
    warn.mockRestore();
  });

  it('names an unknown message once, never as [object MessageEvent]', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = await directGetPort(vi.fn() as never, undefined)();
    port.postMessage({ hello: 1 });
    port.postMessage({ hello: 2 });
    await until(() => warn.mock.calls.length > 0);
    await new Promise(r => setTimeout(r, 20));
    expect(warn.mock.calls).toEqual([
      ['[direct-client] ignored message event: an object with hello'],
    ]);
    port.close();
    warn.mockRestore();
  });
});
