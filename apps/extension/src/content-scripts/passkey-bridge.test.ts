/**
 * The page writes every byte of a passkey request. Before this fix the bridge
 * spread the page's payload after `type`, so a page could name any handler
 * (`ZafuKeplr`, an approval result) and speak for any origin. These tests pin
 * that the bridge sets `type` itself and forwards only the fields each kind uses.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { passkeyMessage } from './passkey-wire';

const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await import('./passkey-bridge');
});

beforeEach(() => {
  sendMessage.mockClear();
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

  it('drops a kind it does not relay', () => {
    pagePosts({ ...hostile('get'), kind: 'ZafuKeplr' });
    pagePosts({ ...hostile('get'), kind: 'toString' });
    expect(sendMessage).not.toHaveBeenCalled();
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
