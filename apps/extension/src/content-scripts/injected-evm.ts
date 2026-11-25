/**
 * MAIN-world evm provider (EIP-1193), announced through EIP-6963 so a dapp's
 * wallet list shows "Zafu" beside any other wallet. window.ethereum is
 * opt-in (the bridge says when the person turned it on), taken only when
 * nothing holds it, and stays writable, so a wallet that injects later
 * still wins the slot.
 *
 * This script has no chrome.runtime access: it posts each call to the
 * ISOLATED bridge (keplr-bridge.ts, channel 'zafu-evm'), which relays to the
 * service worker and back, and passes on the worker's chain changes. Nothing here holds a key or decides anything; every
 * connection, transaction and signature is approved in zafu.
 */

import icon from '../../public/favicon/icon32.png?inline';

const CHANNEL = 'zafu-evm';

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let seq = 0;

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) {
    return;
  }
  const d = ev.data as
    | {
        channel?: string;
        direction?: string;
        id?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
        code?: number;
      }
    | undefined;
  if (d?.channel !== CHANNEL || d.direction !== 'response' || !d.id) {
    return;
  }
  const waiting = pending.get(d.id);
  if (!waiting) {
    return;
  }
  pending.delete(d.id);
  if (d.ok) {
    waiting.resolve(d.result);
  } else {
    // an EIP-1193 error: wallet libraries read the code (4001, 4100, 4200, 4902)
    waiting.reject(
      Object.assign(new Error(d.error ?? 'zafu could not answer'), { code: d.code ?? 4900 }),
    );
  }
});

const call = (method: string, params: unknown): Promise<unknown> => {
  const id = `${Date.now()}-${seq++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage(
      { channel: CHANNEL, direction: 'request', id, method, params },
      window.origin,
    );
  });
};

type Listener = (...args: unknown[]) => void;
const listeners = new Map<string, Set<Listener>>();
const emit = (event: string, value: unknown) => listeners.get(event)?.forEach(l => l(value));

// what this page was last told, so a change is announced once
let chainId: unknown;
let accounts = '[]';

const sawChain = (next: unknown) => {
  if (chainId !== undefined && next !== chainId) {
    emit('chainChanged', next);
  }
  chainId = next;
};
const sawAccounts = (next: unknown) => {
  const key = JSON.stringify(next);
  if (key !== accounts) {
    accounts = key;
    emit('accountsChanged', next);
  }
};

/** after a call succeeds: what it tells the page's listeners */
const AFTER: Partial<Record<string, (result: unknown) => unknown>> = {
  eth_chainId: sawChain,
  eth_accounts: sawAccounts,
  eth_requestAccounts: sawAccounts,
  wallet_switchEthereumChain: () => call('eth_chainId', []).then(sawChain),
  wallet_addEthereumChain: () => call('eth_chainId', []).then(sawChain),
};

const provider = {
  isZafu: true,
  request: async ({ method, params }: { method: string; params?: unknown }) => {
    const result = await call(method, params ?? []);
    await AFTER[method]?.(result);
    return result;
  },
  on(event: string, listener: Listener) {
    listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    return provider;
  },
  removeListener(event: string, listener: Listener) {
    listeners.get(event)?.delete(listener);
    return provider;
  },
};

const info = Object.freeze({
  uuid: crypto.randomUUID(),
  name: 'Zafu',
  icon,
  rdns: 'net.rotko.zafu',
});
const announce = () =>
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }),
  );
window.addEventListener('eip6963:requestProvider', announce);
announce();

const installEthereum = () => {
  if (!('ethereum' in window)) {
    Object.defineProperty(window, 'ethereum', {
      value: provider,
      writable: true,
      configurable: true,
    });
  }
};

/**
 * What the bridge says unasked. A page could forge either: that only installs
 * this same provider in window.ethereum, or makes its own provider announce a
 * chain change, on that page alone.
 */
const FROM_BRIDGE: Partial<Record<string, (d: { event?: unknown; value?: unknown }) => void>> = {
  ethereum: installEthereum,
  event: d => d.event === 'chainChanged' && sawChain(d.value),
};

window.addEventListener('message', (ev: MessageEvent) => {
  const d = ev.data as
    | { channel?: string; direction?: string; event?: unknown; value?: unknown }
    | undefined;
  if (ev.source === window && d?.channel === CHANNEL && d.direction) {
    FROM_BRIDGE[d.direction]?.(d);
  }
});
