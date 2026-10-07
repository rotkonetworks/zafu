/**
 * The page writes every byte of a passkey request. Before this fix the bridge
 * spread the page's payload after `type`, so a page could name any handler
 * (`ZafuKeplr`, an approval result) and speak for any origin. These tests pin
 * that the bridge sets `type` itself and forwards only the fields each kind uses.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passkeyMessage, passkeyPageResult, promptCooldown } from './passkey-wire';

const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await import('./passkey-bridge');
});

const clicked = (isActive: boolean) =>
  Object.defineProperty(navigator, 'userActivation', { value: { isActive }, configurable: true });

beforeEach(() => {
  sendMessage.mockClear();
  clicked(true);
});

/** what a hostile page posts: a valid passkey kind wrapping a Keplr request */
const hostile = (kind: string) => ({
  channel: 'zafu-passkey',
  direction: 'request',
  id: `req-${kind}`,
  kind,
  payload: {
    rpId: 'evil.example',
    challenge: 'aa',
    clientDataHash: 'bb',
    type: 'ZafuKeplr',
    method: 'getKey',
    params: { chainId: 'osmosis-1' },
    origin: 'https://app.skip.build',
    requestId: 'r',
    result: { approved: true },
  },
});

const pagePosts = (data: unknown): void => {
  const ev = new MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { value: window });
  window.dispatchEvent(ev);
};

describe('passkey bridge', () => {
  it.each(['get', 'create'])(
    'a %s payload carrying `type` reaches only the passkey handler',
    kind => {
      pagePosts(hostile(kind));
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const sent = sendMessage.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent['type']).toBe(kind === 'get' ? 'zafu_passkey_get' : 'zafu_passkey_create');
      for (const smuggled of ['method', 'params', 'origin', 'requestId', 'result']) {
        expect(sent).not.toHaveProperty(smuggled);
      }
    },
  );

  it('asks nothing without a click on the page', () => {
    clicked(false);
    pagePosts(hostile('get'));
    pagePosts(hostile('create'));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('drops a kind it does not relay', () => {
    pagePosts({ ...hostile('get'), kind: 'ZafuKeplr' });
    pagePosts({ ...hostile('get'), kind: 'toString' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('passkeyPageResult', () => {
  it("gives the page a fixed refusal, never the worker's own words", () => {
    expect(
      passkeyPageResult({ success: false, error: 'failed to decrypt vault', code: 'failed' }),
    ).toEqual({ success: false, code: 'failed' });
    expect(passkeyPageResult({ success: false, error: 'rpId does not match origin' })).toEqual({
      success: false,
    });
    expect(passkeyPageResult({ success: false, error: 'x', code: 'no-wallet' })).toEqual({
      success: false,
    });
    // the window-closed sweep's shape
    expect(passkeyPageResult({ success: false, error: 'cancelled', cancelled: true })).toEqual({
      success: false,
      code: 'cancelled',
    });
    expect(passkeyPageResult(undefined)).toBeUndefined();
  });

  it('passes only the credential fields on success', () => {
    expect(
      passkeyPageResult({ success: true, credentialId: 'ab', signature: 'cd', secret: 'x' }),
    ).toEqual({ success: true, credentialId: 'ab', signature: 'cd' });
  });
});

describe('promptCooldown', () => {
  it('waits 30 s after not now, then twice as long, and resets after a sign-in', () => {
    const c = promptCooldown();
    expect(c.quiet(0)).toBe(false);
    c.after({ success: false, code: 'denied' }, 0);
    expect(c.quiet(29_999)).toBe(true);
    expect(c.quiet(30_000)).toBe(false);
    c.after({ success: false, code: 'cancelled' }, 30_000);
    expect(c.quiet(89_999)).toBe(true);
    expect(c.quiet(90_000)).toBe(false);
    c.after({ success: true }, 90_000);
    c.after({ success: false, code: 'denied' }, 100_000);
    expect(c.quiet(130_000)).toBe(false);
  });

  it('does not wait after a refusal the person never saw', () => {
    const c = promptCooldown();
    c.after({ success: false }, 0);
    c.after(undefined, 0);
    c.after({ success: false, code: 'failed' }, 0);
    expect(c.quiet(1)).toBe(false);
  });
});

describe('passkeyMessage', () => {
  it('refuses malformed fields instead of forwarding them', () => {
    expect(passkeyMessage('get', { rpId: 'a.example', clientDataHash: 'zz' })).toBeUndefined();
    expect(passkeyMessage('get', { rpId: 1, clientDataHash: 'aa' })).toBeUndefined();
    expect(
      passkeyMessage('get', { rpId: 'a.example', clientDataHash: 'aa', prfSalts: 'x' }),
    ).toBeUndefined();
    expect(
      passkeyMessage('create', { rpId: 'a.example', challenge: 'aa', prfRequested: 'yes' }),
    ).toBeUndefined();
  });

  it('keeps the fields the handlers read', () => {
    expect(
      passkeyMessage('get', {
        rpId: 'a.example',
        challenge: 'ccdd',
        clientDataHash: 'aabb',
        prfSalts: { first: '01' },
        allowCredentials: [{ id: 'cc', type: 'public-key' }],
      }),
    ).toEqual({
      type: 'zafu_passkey_get',
      rpId: 'a.example',
      challenge: 'ccdd',
      clientDataHash: 'aabb',
      prfSalts: { first: '01' },
      allowCredentials: [{ id: 'cc', type: 'public-key' }],
    });
  });
});
