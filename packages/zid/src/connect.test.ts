import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, ZafuError } from '.';

/**
 * A fake zafu: the injected penumbra provider (for `provider.connect()`) plus
 * the extension bridge (`chrome.runtime.sendMessage`) answering `ping` and
 * `zafu_sign`. Each test decides how connect and sign behave.
 */
const ORIGIN = 'chrome-extension://zafutestid/';

interface FakeWallet {
  connect: () => Promise<void>;
  sign: () => unknown;
}

const install = (wallet: FakeWallet) => {
  const g = globalThis as Record<PropertyKey, unknown>;
  g[Symbol.for('penumbra')] = { [ORIGIN]: { connect: wallet.connect } };
  g['chrome'] = {
    runtime: {
      lastError: undefined,
      sendMessage: (_id: string, req: { type: string }, cb: (r: unknown) => void) => {
        if (req.type === 'ping') {
          cb({ zafu: true, version: 'test', protocolVersion: 1, protocolVersions: [1] });
        } else if (req.type === 'zafu_sign') {
          void Promise.resolve(wallet.sign()).then(cb);
        } else {
          cb({ error: 'unexpected' });
        }
      },
    },
  };
};

const SIGNED = { success: true, publicKey: 'aa'.repeat(32), signature: 'bb'.repeat(64) };

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>)['localStorage'] = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
});

afterEach(() => {
  const g = globalThis as Record<PropertyKey, unknown>;
  Reflect.deleteProperty(g, Symbol.for('penumbra'));
  Reflect.deleteProperty(g, 'chrome');
  vi.useRealTimers();
});

describe('connect', () => {
  it('connects through the wallet and reports waiting then done', async () => {
    install({ connect: () => Promise.resolve(), sign: () => SIGNED });
    const onWaiting = vi.fn();
    const statuses: string[] = [];

    const me = await connect({ appName: 'test', onWaiting, onStatus: s => statuses.push(s) });

    expect(me.mode).toBe('zafu');
    expect(me.walletPubkey).toBe(SIGNED.publicKey);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['waiting', 'done']);
  });

  it('a double click sends one wallet request, not two', async () => {
    const walletConnect = vi.fn(() => Promise.resolve());
    install({ connect: walletConnect, sign: () => SIGNED });

    const [a, b] = await Promise.all([connect({ appName: 'dbl' }), connect({ appName: 'dbl' })]);

    expect(walletConnect).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('throws denied instead of silently becoming a guest', async () => {
    install({
      connect: () => Promise.reject(Object.assign(new Error('no'), { cause: 'Denied' })),
      sign: () => SIGNED,
    });
    const err = await connect({ appName: 'denied' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZafuError);
    expect((err as ZafuError).code).toBe('denied');
  });

  it('throws locked when the wallet needs its password', async () => {
    install({
      connect: () => Promise.reject(Object.assign(new Error('login'), { cause: 'NeedsLogin' })),
      sign: () => SIGNED,
    });
    await expect(connect({ appName: 'locked' })).rejects.toMatchObject({ code: 'locked' });
  });

  it('maps a declined signature to a typed error', async () => {
    install({
      connect: () => Promise.resolve(),
      sign: () => ({ success: false, error: 'user declined', code: 'denied' }),
    });
    await expect(connect({ appName: 'sig' })).rejects.toMatchObject({ code: 'denied' });
  });

  it('keeps waiting for a slow approval instead of timing out', async () => {
    vi.useFakeTimers();
    let approve!: () => void;
    install({
      connect: () =>
        new Promise<void>(res => {
          approve = res;
        }),
      sign: () => SIGNED,
    });
    const statuses: string[] = [];
    const pending = connect({
      appName: 'slow',
      slowAfterMs: 1000,
      onStatus: s => statuses.push(s),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(statuses).toEqual(['waiting', 'slow']);

    approve();
    await expect(pending).resolves.toMatchObject({ mode: 'zafu' });
  });

  it('falls back to a guest identity only when no wallet is installed', async () => {
    const me = await connect({ appName: 'guest' });
    expect(me.mode).toBe('ephemeral');
  });

  it('requireWallet throws unavailable when no wallet is installed', async () => {
    await expect(connect({ appName: 'req', requireWallet: true })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
