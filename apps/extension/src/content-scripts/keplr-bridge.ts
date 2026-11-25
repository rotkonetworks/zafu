/**
 * ISOLATED-world bridge for zafu's page providers: the Keplr provider
 * (injected-keplr.ts) and the evm provider (injected-evm.ts). Neither has
 * chrome.runtime access, so each posts method calls to the window on its own
 * channel; this script relays them to the service worker and posts the
 * response back. Binary already crosses as base64 (see injected-keplr.ts), so
 * everything here is plain JSON.
 */
// egress guard first: nothing may capture fetch or open a socket before it
import '../net/egress-install-lite';

import { ZafuControl } from './message/zafu-control';

const CHANNEL = 'zafu-keplr';
const EVM_CHANNEL = 'zafu-evm';

interface WireRequest {
  channel: string;
  direction: string;
  id: string;
  method: string;
  params: unknown;
  // true when the call came through zafu's OWN provider (window.zafu) rather
  // than the window.keplr impersonation. Native calls are never gated by the
  // Keplr-compat opt-in - picking "Zafu" explicitly IS the consent.
  native?: boolean;
}

// Keplr compatibility is OPT-IN and enforced HERE, on the request path - not
// just at install. The MAIN-world provider is reachable by forged postMessages,
// so gating only the install is cosmetic; the ISOLATED-world bridge (the only
// side with chrome.storage) is the trustworthy enforcement point. Track the flag
// live so a mid-session toggle applies, and fail closed (drop) until it's read.
let keplrEnabled = false;

/**
 * Each channel's message type for the worker, and why a request is refused
 * here, if it is. The opt-in gate applies ONLY to the window.keplr
 * impersonation: zafu's own providers (window.zafu, the evm provider) neither
 * impersonate nor clobber another wallet, and every signature still needs
 * explicit in-extension approval, so there is nothing to gate behind a setting.
 */
const CHANNELS: Record<string, { type: string; refuse: (r: WireRequest) => string | undefined }> = {
  [CHANNEL]: {
    type: 'ZafuKeplr',
    refuse: r =>
      r.native || keplrEnabled ? undefined : 'keplr compatibility is disabled in zafu settings',
  },
  'zafu-evm': { type: 'ZafuEvm', refuse: () => undefined },
};

const isRequest = (d: unknown): d is WireRequest =>
  typeof d === 'object' &&
  d !== null &&
  Object.hasOwn(CHANNELS, (d as { channel?: unknown }).channel as string) &&
  (d as { direction?: unknown }).direction === 'request' &&
  typeof (d as { id?: unknown }).id === 'string';

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window || !isRequest(ev.data)) {
    return;
  }
  const { channel, id, method, params } = ev.data;
  const relay = CHANNELS[channel]!;

  const respond = (payload: { ok: boolean; result?: unknown; error?: string; code?: number }) =>
    window.postMessage({ channel, direction: 'response', id, ...payload }, window.origin);

  const refused = relay.refuse(ev.data);
  if (refused) {
    respond({ ok: false, error: refused });
    return;
  }

  // orphaned content script (extension reloaded in an open tab) - fail cleanly
  if (!chrome.runtime?.id || chrome.runtime.id === 'invalid') {
    respond({ ok: false, error: 'wallet unavailable - reload the page' });
    return;
  }

  chrome.runtime
    .sendMessage({ type: relay.type, method, params })
    .then((res: { ok?: boolean; result?: unknown; error?: string; code?: number } | undefined) => {
      if (res?.ok) {
        respond({ ok: true, result: res.result });
      } else {
        respond({ ok: false, error: res?.error ?? 'request failed', code: res?.code });
      }
    })
    .catch((err: unknown) =>
      respond({ ok: false, error: err instanceof Error ? err.message : 'request failed' }),
    );
});

// Read the opt-in flag and, only when on, tell the MAIN-world provider to install
// window.keplr (a real Keplr otherwise keeps the slot). This drives BOTH the
// install and the request-path gate above (keplrEnabled). Kept live via
// storage.onChanged so a toggle applies without a page reload.
const applyKeplrCompat = (on: boolean): void => {
  keplrEnabled = on;
  if (on) {
    window.postMessage({ channel: CHANNEL, direction: 'enable' }, window.origin);
  }
};

/**
 * Each opt-in this bridge reads, and what it does on the page. window.ethereum
 * is opt-in like window.keplr: off, zafu's evm provider is announced through
 * EIP-6963 only and leaves the slot to any other wallet.
 */
const SETTINGS: Record<string, (on: boolean) => void> = {
  keplrCompat: applyKeplrCompat,
  evmWindowEthereum: on =>
    on && window.postMessage({ channel: EVM_CHANNEL, direction: 'ethereum' }, window.origin),
};

if (chrome.runtime?.id && chrome.runtime.id !== 'invalid') {
  // zafu's own provider (window.zafu) appears only on a site the person already
  // connected: the service worker sends Preconnect for an approved site on load,
  // and Init when they approve one now. Elsewhere it no longer announces zafu
  // to a page that merely looks.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id) {
      return;
    }
    if (message === ZafuControl.Preconnect || message === ZafuControl.Init) {
      window.postMessage({ channel: CHANNEL, direction: 'native' }, window.origin);
    }
    // the worker telling this site's evm provider something changed (its chain)
    const evm = message as { type?: unknown; event?: unknown; value?: unknown } | undefined;
    if (evm?.type === 'ZafuEvmEvent') {
      window.postMessage(
        { channel: EVM_CHANNEL, direction: 'event', event: evm.event, value: evm.value },
        window.origin,
      );
    }
  });

  chrome.storage.local
    .get(Object.keys(SETTINGS))
    .then(stored => {
      for (const [key, apply] of Object.entries(SETTINGS)) {
        apply(stored[key] === true);
      }
    })
    .catch(() => undefined);

  chrome.storage.onChanged.addListener((changes, area) => {
    for (const [key, apply] of Object.entries(SETTINGS)) {
      if (area === 'local' && key in changes) {
        apply(changes[key]?.newValue === true);
      }
    }
  });
}
