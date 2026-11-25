/**
 * The evm provider's request routing, as a site meets it: which methods
 * exist, what an unconnected site can and cannot do, the chain allow-list,
 * and EIP-1193 error codes on every refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// external-easteregg registers its closed-window sweep at import
vi.hoisted(() => {
  (globalThis.chrome as unknown as { windows: unknown }).windows = {
    onRemoved: { addListener: () => undefined },
  };
});
vi.mock('../../needs-login', () => ({ throwIfNeedsLogin: () => Promise.resolve() }));
const window_ = vi.hoisted(() => ({ askInWindow: vi.fn() }));
vi.mock('./approval-window', () => window_);

import { bech32mAddress } from '@penumbra-zone/bech32m/penumbra';
import { denyCapability, grantCapability } from '@repo/storage-chrome/origin';
import { localExtStorage } from '@repo/storage-chrome/local';
import { HANDLERS, createEvmMessageListener, evmRequest, penumbraOwner } from './evm';

const site = { origin: 'https://veil.example' };
const whose = vi.fn(() => Promise.resolve(undefined));
const call = (method: string, params: unknown[] = []) =>
  evmRequest(method, params, { site, whose });
const evmMessageListener = createEvmMessageListener(whose);

const tabs = { query: vi.fn(), sendMessage: vi.fn() };
beforeEach(async () => {
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  window_.askInWindow.mockReset().mockResolvedValue({ approved: false, error: 'rejected' });
  tabs.query.mockReset().mockResolvedValue([]);
  tabs.sendMessage.mockReset().mockResolvedValue(undefined);
  (chrome as unknown as { tabs: unknown }).tabs = tabs;
});

/** a phrase wallet, the kind that signs evm */
const hotWallet = async () => {
  await localExtStorage.set('vaults', [{ id: 'h', type: 'mnemonic', insensitive: {} }] as never);
  await localExtStorage.set('selectedVaultId', 'h');
};
// the setup's chrome is a stubbed global too, so fetch is put back by hand
const realFetch = globalThis.fetch;
const stubFetch = (f: unknown) => (globalThis.fetch = f as typeof fetch);
afterEach(() => stubFetch(realFetch));

describe('the routing table', () => {
  it('serves exactly the methods a dapp needs', () => {
    expect(Object.keys(HANDLERS).sort()).toEqual(
      [
        'eth_accounts',
        'eth_blockNumber',
        'eth_call',
        'eth_chainId',
        'eth_estimateGas',
        'eth_feeHistory',
        'eth_gasPrice',
        'eth_getBalance',
        'eth_getCode',
        'eth_getLogs',
        'eth_getTransactionByHash',
        'eth_getTransactionCount',
        'eth_getTransactionReceipt',
        'eth_maxPriorityFeePerGas',
        'eth_requestAccounts',
        'eth_sendTransaction',
        'net_version',
        'personal_sign',
        'wallet_addEthereumChain',
        'wallet_switchEthereumChain',
      ].sort(),
    );
  });

  it.each([
    'eth_sign',
    'eth_signTypedData_v4',
    'eth_sendRawTransaction',
    'constructor',
    '__proto__',
  ])('refuses %s with 4200', async method => {
    await expect(call(method)).rejects.toMatchObject({ code: 4200 });
  });
});

describe('a site that has not connected', () => {
  it('is on bnb smart chain', async () => {
    expect(await call('eth_chainId')).toBe('0x38');
    expect(await call('net_version')).toBe('56');
  });

  it('sees no accounts', async () => {
    expect(await call('eth_accounts')).toEqual([]);
  });

  it.each(['eth_call', 'eth_getBalance', 'eth_sendTransaction', 'personal_sign'])(
    'is refused %s with 4100, and zafu reaches no node for it',
    async method => {
      const fetch = vi.fn();
      stubFetch(fetch);
      await expect(call(method, [{}])).rejects.toMatchObject({ code: 4100 });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('switches among the offered chains only', async () => {
    expect(await call('wallet_switchEthereumChain', [{ chainId: '0x61' }])).toBeNull();
    expect(await call('eth_chainId')).toBe('0x61');
    await expect(call('wallet_switchEthereumChain', [{ chainId: '0x1' }])).rejects.toMatchObject({
      code: 4902,
    });
    await expect(call('wallet_addEthereumChain', [{ chainId: '0x89' }])).rejects.toMatchObject({
      code: 4902,
    });
    expect(await call('eth_chainId')).toBe('0x61');
  });

  it("tells every open tab of the site, and only the site's, when its chain changes", async () => {
    tabs.query.mockResolvedValue([
      { id: 1, url: 'https://veil.example/a' },
      { id: 2, url: 'https://veil.example/b?x' },
      { id: 3, url: 'https://other.example/' },
    ]);
    await call('wallet_switchEthereumChain', [{ chainId: '0x61' }]);
    expect(tabs.sendMessage.mock.calls).toEqual([
      [1, { type: 'ZafuEvmEvent', event: 'chainChanged', value: '0x61' }],
      [2, { type: 'ZafuEvmEvent', event: 'chainChanged', value: '0x61' }],
    ]);
    tabs.sendMessage.mockClear();
    await call('wallet_switchEthereumChain', [{ chainId: '0x61' }]);
    expect(tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('finds the local dev chain only while beta features are on', async () => {
    await localExtStorage.set('betaFeatures', false);
    await expect(call('wallet_switchEthereumChain', [{ chainId: '0x7a69' }])).rejects.toMatchObject(
      { code: 4902 },
    );
    await localExtStorage.set('betaFeatures', true);
    expect(await call('wallet_switchEthereumChain', [{ chainId: '0x7a69' }])).toBeNull();
    expect(await call('eth_chainId')).toBe('0x7a69');
  });

  it('learns nothing of the wallet: every refusal before a window reads the same', async () => {
    const refusal = { code: 4100, message: "zafu can't connect this site" };
    // a wallet that can't sign evm
    await localExtStorage.set('vaults', [
      { id: 'z', type: 'zigner-zafu', insensitive: {} },
    ] as never);
    await localExtStorage.set('selectedVaultId', 'z');
    await expect(call('eth_requestAccounts')).rejects.toMatchObject(refusal);
    // evm turned off, with a phrase wallet
    await hotWallet();
    await localExtStorage.set('capabilityModes', { evm: 'disabled' });
    await expect(call('eth_requestAccounts')).rejects.toMatchObject(refusal);
    expect(window_.askInWindow).not.toHaveBeenCalled();
  });

  it('is not asked again once the person turned evm off for it', async () => {
    await hotWallet();
    await denyCapability(site.origin, 'evm');
    await expect(call('eth_requestAccounts')).rejects.toMatchObject({ code: 4100 });
    expect(window_.askInWindow).not.toHaveBeenCalled();
  });

  it('after "not now", is answered no without a window for a while', async () => {
    await hotWallet();
    await expect(call('eth_requestAccounts')).rejects.toMatchObject({ code: 4001 });
    await expect(call('eth_requestAccounts')).rejects.toMatchObject({ code: 4001 });
    await expect(call('eth_requestAccounts')).rejects.toMatchObject({ code: 4001 });
    expect(window_.askInWindow).toHaveBeenCalledTimes(1);
  });
});

describe('a connected site', () => {
  it("reads its chain's node as asked", async () => {
    await grantCapability(site.origin, 'evm');
    await localExtStorage.set('betaFeatures', true);
    await call('wallet_switchEthereumChain', [{ chainId: '0x7a69' }]);
    const fetch = vi.fn(() =>
      Promise.resolve(new Response('{"jsonrpc":"2.0","id":1,"result":"0x2a"}')),
    );
    stubFetch(fetch);

    expect(await call('eth_blockNumber')).toBe('0x2a');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8545');
    expect(JSON.parse(init.body as string)).toMatchObject({
      method: 'eth_blockNumber',
      params: [],
    });
  });

  it("passes on the node's own error code", async () => {
    await grantCapability(site.origin, 'evm');
    stubFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(
            '{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}',
          ),
        ),
      ),
    );
    await expect(call('eth_call', [{}, 'latest'])).rejects.toMatchObject({
      code: 3,
      message: 'execution reverted',
    });
  });
});

describe('the listener', () => {
  const sender = {
    tab: { id: 1 } as chrome.tabs.Tab,
    frameId: 0,
    origin: site.origin,
    url: `${site.origin}/`,
    documentLifecycle: 'active',
    documentId: 'doc-1',
  } as chrome.runtime.MessageSender;

  it('answers with the EIP-1193 code', async () => {
    const reply = await new Promise(resolve =>
      expect(
        evmMessageListener({ type: 'ZafuEvm', method: 'eth_sign', params: [] }, sender, resolve),
      ).toBe(true),
    );
    expect(reply).toMatchObject({ ok: false, code: 4200 });
  });

  it('refuses a sender that is not a top-level page', () => {
    const respond = vi.fn();
    evmMessageListener(
      { type: 'ZafuEvm', method: 'eth_chainId' },
      { ...sender, frameId: 3 },
      respond,
    );
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 4100 }));
  });

  it('leaves other messages to other listeners', () => {
    expect(evmMessageListener({ type: 'ZafuKeplr', method: 'enable' }, sender, vi.fn())).toBe(
      false,
    );
  });
});

describe('whose a penumbra receiver is', () => {
  const receiver = bech32mAddress({ inner: new Uint8Array(80).fill(7) });
  const viewing = (answer: () => Promise<unknown>) => {
    const indexByAddress = vi.fn(answer);
    return {
      indexByAddress,
      whose: penumbraOwner(() => Promise.resolve({ indexByAddress } as never)),
    };
  };

  it('is one of yours, one-time when its index carries a randomizer', async () => {
    const own = viewing(() =>
      Promise.resolve({ addressIndex: { account: 0, randomizer: new Uint8Array(12) } }),
    );
    expect(await own.whose(receiver)).toBe('account');
    expect(own.indexByAddress.mock.calls[0]).toMatchObject([
      { address: { inner: new Uint8Array(80).fill(7) } },
    ]);
    const once = viewing(() =>
      Promise.resolve({ addressIndex: { account: 0, randomizer: new Uint8Array(12).fill(1) } }),
    );
    expect(await once.whose(receiver)).toBe('one-time');
  });

  it('is not yours when the view service finds no index', async () => {
    expect(await viewing(() => Promise.resolve({})).whose(receiver)).toBe('not-yours');
  });

  it("is unknown, never yours, when zafu can't ask", async () => {
    expect(
      await viewing(() => Promise.reject(new Error('locked'))).whose(receiver),
    ).toBeUndefined();
    expect(await viewing(() => Promise.resolve({})).whose('penumbra1notanaddress')).toBeUndefined();
    vi.useFakeTimers();
    const slow = viewing(() => new Promise(() => undefined)).whose(receiver);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await slow).toBeUndefined();
    vi.useRealTimers();
  });
});
