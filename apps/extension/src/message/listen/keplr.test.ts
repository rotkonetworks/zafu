/**
 * FUND SAFETY: Ethermint chains (Injective, eth_secp256k1 / coin type 60) must
 * never be served over the Keplr provider - the shared coin-118 cosmos path
 * derives a plausible but unspendable `inj1` address. The guard runs before any
 * popup opens, and it must surface as a handled `{ok: false}` reply: the
 * listener returns its response over `sendResponse`, so a thrown error here
 * would reach the dapp as an unhandled rejection in the page's console instead
 * of a refused request.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// external-easteregg registers its closed-window sweep at import: catch it
const removed = vi.hoisted(() => {
  const listeners: ((windowId: number) => void)[] = [];
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    onRemoved: { addListener: (l: (id: number) => void) => listeners.push(l) },
  };
  return listeners;
});
const needsLogin = vi.hoisted(() => ({ throwIfNeedsLogin: vi.fn(() => Promise.resolve()) }));
vi.mock('../../needs-login', () => needsLogin);

import { keplrMessageListener } from './keplr';

const sender = (origin: string): chrome.runtime.MessageSender => ({
  tab: { id: 1 } as chrome.tabs.Tab,
  frameId: 0,
  origin,
  url: `${origin}/index.html`,
  // real top-frame senders carry these; isValidExternalSender requires them
  documentLifecycle: 'active',
  documentId: 'doc-1',
});

let createMock: Mock;

const call = (req: unknown, s: chrome.runtime.MessageSender): Promise<unknown> =>
  new Promise(resolve => {
    const asyncResponse = keplrMessageListener(req, s, resolve);
    // the response is delivered later, over sendResponse
    expect(asyncResponse).toBe(true);
  });

let nextWindow = 1;

beforeEach(() => {
  needsLogin.throwIfNeedsLogin.mockReset().mockResolvedValue(undefined);
  createMock = vi.fn(() => Promise.resolve({ id: nextWindow++ }));
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    create: createMock,
    getLastFocused: vi.fn(() => Promise.resolve({ id: 7, top: 0, left: 0, width: 800 })),
  };
});

describe('ZafuKeplr Ethermint guard', () => {
  const origin = 'https://dapp.example';

  it.each([
    ['enable', { chainIds: ['injective-1'] }],
    ['getKey', { chainId: 'injective-1' }],
    ['signDirect', { chainId: 'injective-1' }],
    ['signAmino', { chainId: 'injective-1' }],
    ['sendTx', { chainId: 'injective-1' }],
    ['signArbitrary', { chainId: 'injective-1' }],
    ['verifyArbitrary', { chainId: 'injective-1' }],
  ])('refuses %s on injective-1 as a handled failure', async (method, params) => {
    const res = await call({ type: 'ZafuKeplr', method, params, origin }, sender(origin));

    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/Ethermint/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a mixed enable that includes an Ethermint chain', async () => {
    const res = await call(
      {
        type: 'ZafuKeplr',
        method: 'enable',
        params: { chainIds: ['noble-1', 'injective-1'] },
        origin,
      },
      sender(origin),
    );

    expect(res).toMatchObject({ ok: false });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reports an unknown method as a handled failure, not a rejection', async () => {
    const res = await call(
      { type: 'ZafuKeplr', method: 'nonsense', params: {}, origin },
      sender(origin),
    );

    expect(res).toMatchObject({ ok: false, error: 'unsupported method nonsense' });
  });
});

describe('ZafuKeplr origin and result senders', () => {
  it('keys state by the browser-attested sender, never a message `origin`', async () => {
    const res = await call(
      {
        type: 'ZafuKeplr',
        method: 'experimentalSuggestChain',
        params: { chainInfo: { chainId: 'x' } },
        origin: 'https://app.skip.build',
      },
      sender('https://evil.example'),
    );
    expect(res).toMatchObject({ ok: true });
    const stored = await chrome.storage.session.get(null);
    expect(stored).toHaveProperty(['keplrSuggested:https://evil.example']);
    expect(stored).not.toHaveProperty(['keplrSuggested:https://app.skip.build']);
  });

  it('drops an approval result that a content script sends', () => {
    const respond = vi.fn();
    const result = { type: 'zafu_keplr_result', requestId: 'r', result: { approved: true } };
    // a content script carries the extension id, like zafu's own pages
    const contentScript = { ...sender('https://evil.example'), id: chrome.runtime.id };
    expect(keplrMessageListener(result, contentScript, respond)).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    // zafu's own approval page is still heard
    const page: chrome.runtime.MessageSender = {
      id: chrome.runtime.id,
      origin: `chrome-extension://${chrome.runtime.id}`,
      url: `chrome-extension://${chrome.runtime.id}/popup.html`,
    };
    keplrMessageListener(result, page, respond);
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it('asks once when a site enables a chain and reads its key at the same moment', async () => {
    const origin = 'https://penumbra.example';
    const s = sender(origin);
    const page: chrome.runtime.MessageSender = {
      id: chrome.runtime.id,
      origin: `chrome-extension://${chrome.runtime.id}`,
      url: `chrome-extension://${chrome.runtime.id}/popup.html`,
    };
    (chrome.runtime as { getURL?: (p: string) => string }).getURL = p =>
      `chrome-extension://${chrome.runtime.id}/${p}`;
    const key = { name: 'zafu', bech32Address: 'noble1x' };
    const enable = call(
      { type: 'ZafuKeplr', method: 'enable', params: { chainIds: ['noble-1'] }, origin },
      s,
    );
    const getKey = call(
      { type: 'ZafuKeplr', method: 'getKey', params: { chainId: 'noble-1' }, origin },
      s,
    );
    // the one approval the person sees
    await vi.waitFor(async () => {
      const ids = Object.keys(await chrome.storage.session.get(null)).filter(k =>
        k.startsWith('keplrApproval:'),
      );
      expect(ids).toHaveLength(1);
    });
    const [approval] = Object.keys(await chrome.storage.session.get(null)).filter(k =>
      k.startsWith('keplrApproval:'),
    );
    keplrMessageListener(
      {
        type: 'zafu_keplr_result',
        requestId: approval!.slice('keplrApproval:'.length),
        result: { approved: true, payload: { keys: { 'noble-1': key } } },
      },
      page,
      vi.fn(),
    );
    expect(await enable).toMatchObject({ ok: true });
    expect(await getKey).toMatchObject({ ok: true, result: key });
    // and enabling it again later asks nothing
    expect(
      await call(
        { type: 'ZafuKeplr', method: 'enable', params: { chainIds: ['noble-1'] }, origin },
        s,
      ),
    ).toMatchObject({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe('ZafuKeplr ADR-036', () => {
  const origin = 'https://dapp.example';
  // keplr's signature over 'hello from zafu' (see packages/wallet adr036.test.ts)
  const signer = 'cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4';
  const dataB64 = btoa('hello from zafu');
  const signature = {
    pub_key: {
      type: 'tendermint/PubKeySecp256k1',
      value: 'Ak9OKtmcNNYLm6YoPJQxqEGK+GcyEpYfl6d7Y3f80Fti',
    },
    signature:
      'INXJIBwvKgWVWGvXWPfeiu4xfuvi5HJ6qErH8LpwszQZMdkXGZDHLj8LHFdikiXIbhNAKe3NhZGdMh+etdxz3w==',
  };
  const page: chrome.runtime.MessageSender = {
    id: chrome.runtime.id,
    origin: `chrome-extension://${chrome.runtime.id}`,
    url: `chrome-extension://${chrome.runtime.id}/popup.html`,
  };

  it('asks with the ADR-036 sign doc and answers with what the person approved', async () => {
    (chrome.runtime as { getURL?: (p: string) => string }).getURL = p =>
      `chrome-extension://${chrome.runtime.id}/${p}`;
    const signing = call(
      {
        type: 'ZafuKeplr',
        method: 'signArbitrary',
        params: { chainId: 'cosmoshub-4', signerAddress: signer, dataB64 },
      },
      sender(origin),
    );
    let key = '';
    await vi.waitFor(async () => {
      [key = ''] = Object.keys(await chrome.storage.session.get(null)).filter(k =>
        k.startsWith('keplrApproval:'),
      );
      expect(key).not.toBe('');
    });
    const req = (await chrome.storage.session.get(key))[key];
    expect(req).toMatchObject({
      method: 'signArbitrary',
      origin,
      signerAddress: signer,
      signDoc: {
        chain_id: '',
        account_number: '0',
        sequence: '0',
        memo: '',
        fee: { amount: [], gas: '0' },
        msgs: [{ type: 'sign/MsgSignData', value: { signer, data: dataB64 } }],
      },
    });
    keplrMessageListener(
      {
        type: 'zafu_keplr_result',
        requestId: key.slice('keplrApproval:'.length),
        result: { approved: true, payload: signature },
      },
      page,
      vi.fn(),
    );
    expect(await signing).toEqual({ ok: true, result: signature });
  });

  it('verifies without a prompt', async () => {
    const verify = (params: Record<string, unknown>) =>
      call(
        {
          type: 'ZafuKeplr',
          method: 'verifyArbitrary',
          params: { chainId: 'cosmoshub-4', signerAddress: signer, dataB64, signature, ...params },
        },
        sender(origin),
      );
    expect(await verify({})).toEqual({ ok: true, result: true });
    expect(await verify({ dataB64: btoa('hello from zafu.') })).toEqual({
      ok: true,
      result: false,
    });
    expect(await verify({ chainId: 'osmosis-1' })).toEqual({ ok: true, result: false });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('ZafuKeplr signed chain', () => {
  const origin = 'https://dapp.example';
  const amino = (chain_id: string) => ({
    chain_id,
    account_number: '1',
    sequence: '0',
    fee: { amount: [], gas: '200000' },
    msgs: [],
    memo: '',
  });
  const direct = (chainId: string) => ({
    bodyBytesB64: '',
    authInfoBytesB64: '',
    chainId,
    accountNumber: '1',
  });

  it.each([
    ['signAmino', amino('osmosis-1')],
    ['signDirect', direct('osmosis-1')],
    ['signAmino', undefined],
    ['signDirect', 'not a doc'],
  ])('refuses %s when the doc signs another chain than the site names', async (method, doc) => {
    const res = await call(
      {
        type: 'ZafuKeplr',
        method,
        params: { chainId: 'noble-1', signerAddress: 'noble1x', signDoc: doc },
      },
      sender(origin),
    );
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/one chain and signs on another/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses an Ethermint chain hidden in the doc under a harmless label', async () => {
    const res = await call(
      {
        type: 'ZafuKeplr',
        method: 'signDirect',
        params: { chainId: 'noble-1', signDoc: direct('injective-1') },
      },
      sender(origin),
    );
    expect(res).toMatchObject({ ok: false });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('ZafuKeplr sendTx', () => {
  const origin = 'https://dapp.example';
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const send = () =>
    call(
      {
        type: 'ZafuKeplr',
        method: 'sendTx',
        // a page-written flag is not a grant
        params: { chainId: 'noble-1', txB64: btoa('tx'), mode: 'sync', native: true },
        native: true,
      },
      sender(origin),
    );

  it('refuses a site that is not connected to the chain, without reaching any node', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await send();
    expect(res).toMatchObject({ ok: false });
    expect((res as { error: string }).error).toMatch(/isn't connected to noble-1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('broadcasts for a site connected to the chain', async () => {
    await chrome.storage.session.set({
      [`keplrKey:${origin}:noble-1`]: { name: 'zafu', bech32Address: 'noble1x' },
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve({ json: () => Promise.resolve({ result: { code: 0, hash: '0A0B' } }) }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await send()).toEqual({ ok: true, result: { hashB64: btoa('\x0a\x0b') } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await chrome.storage.session.remove(`keplrKey:${origin}:noble-1`);
  });
});

describe('ZafuKeplr approval windows', () => {
  const origin = 'https://window.example';
  const page: chrome.runtime.MessageSender = {
    id: chrome.runtime.id,
    origin: `chrome-extension://${chrome.runtime.id}`,
    url: `chrome-extension://${chrome.runtime.id}/popup.html`,
  };
  const sign = () =>
    call(
      {
        type: 'ZafuKeplr',
        method: 'signAmino',
        params: {
          chainId: 'noble-1',
          signerAddress: 'noble1x',
          signDoc: { chain_id: 'noble-1', msgs: [] },
        },
      },
      sender(origin),
    );
  const openRequests = async () =>
    Object.keys(await chrome.storage.session.get(null)).filter(k => k.startsWith('keplrApproval:'));
  beforeEach(() => {
    (chrome.runtime as { getURL?: (p: string) => string }).getURL = p =>
      `chrome-extension://${chrome.runtime.id}/${p}`;
  });

  it('asks to unlock before it opens a window, and a declined unlock opens none', async () => {
    needsLogin.throwIfNeedsLogin.mockRejectedValueOnce(new Error('Login cancelled'));
    expect(await sign()).toEqual({ ok: false, error: 'Login cancelled' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('answers a window closed without deciding as rejected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signing = sign();
    await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const windowId = ((await createMock.mock.results[0]!.value) as { id: number }).id;
    removed.forEach(l => l(windowId));
    await vi.advanceTimersByTimeAsync(1100);
    expect(await signing).toEqual({ ok: false, error: 'request rejected' });
    expect(await openRequests()).toEqual([]);
    vi.useRealTimers();
    // the site may ask again
    const again = sign();
    await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    const [key] = await openRequests();
    keplrMessageListener(
      {
        type: 'zafu_keplr_result',
        requestId: key!.slice('keplrApproval:'.length),
        result: { approved: false, error: 'rejected' },
      },
      page,
      vi.fn(),
    );
    expect(await again).toEqual({ ok: false, error: 'rejected' });
  });

  it('opens one window per site, and frees it once the person decides', async () => {
    const first = sign();
    await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(await sign()).toEqual({
      ok: false,
      error: "zafu couldn't open this request · another from this site may still be open",
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const [key] = await openRequests();
    keplrMessageListener(
      {
        type: 'zafu_keplr_result',
        requestId: key!.slice('keplrApproval:'.length),
        result: { approved: true, payload: { signed: 'doc' } },
      },
      page,
      vi.fn(),
    );
    expect(await first).toEqual({ ok: true, result: { signed: 'doc' } });
    // decided, but the window has not closed yet: a follow-up still gets its own
    const second = sign();
    await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(2));
    const [key2] = await openRequests();
    keplrMessageListener(
      {
        type: 'zafu_keplr_result',
        requestId: key2!.slice('keplrApproval:'.length),
        result: { approved: false },
      },
      page,
      vi.fn(),
    );
    expect(await second).toMatchObject({ ok: false });
  });
});
