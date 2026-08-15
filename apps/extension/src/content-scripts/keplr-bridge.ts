/**
 * ISOLATED-world bridge for the Keplr provider. The MAIN-world provider
 * (injected-keplr.ts) has no chrome.runtime access, so it posts method calls to
 * the window; this script relays them to the service worker and posts the
 * response back. Binary already crosses as base64 (see injected-keplr.ts), so
 * everything here is plain JSON.
 */

export {}; // module scope - keeps CHANNEL out of the shared ISOLATED-world global

const CHANNEL = 'zafu-keplr';

interface KeplrWireRequest {
  channel: string;
  direction: string;
  id: string;
  method: string;
  params: unknown;
}

const isKeplrRequest = (d: unknown): d is KeplrWireRequest =>
  typeof d === 'object' &&
  d !== null &&
  (d as { channel?: unknown }).channel === CHANNEL &&
  (d as { direction?: unknown }).direction === 'request' &&
  typeof (d as { id?: unknown }).id === 'string';

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window || !isKeplrRequest(ev.data)) {
    return;
  }
  const { id, method, params } = ev.data;

  const respond = (payload: { ok: boolean; result?: unknown; error?: string }) =>
    window.postMessage({ channel: CHANNEL, direction: 'response', id, ...payload }, window.origin);

  // orphaned content script (extension reloaded in an open tab) - fail cleanly
  if (!chrome.runtime?.id || chrome.runtime.id === 'invalid') {
    respond({ ok: false, error: 'wallet unavailable - reload the page' });
    return;
  }

  chrome.runtime
    .sendMessage({ type: 'ZafuKeplr', method, params, origin: window.origin })
    .then((res: { ok?: boolean; result?: unknown; error?: string } | undefined) => {
      if (res?.ok) {
        respond({ ok: true, result: res.result });
      } else {
        respond({ ok: false, error: res?.error ?? 'request failed' });
      }
    })
    .catch((err: unknown) =>
      respond({ ok: false, error: err instanceof Error ? err.message : 'request failed' }),
    );
});
