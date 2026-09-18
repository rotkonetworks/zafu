/**
 * zid transport - the pluggable seam between the SDK and a zafu wallet.
 *
 * The zafu_* message shapes (@zafu/protocol) say WHAT crosses the wire; a
 * ZafuTransport says HOW it gets there. Today the only transport is the
 * extension bridge (chrome.runtime.sendMessage to the zafu extension). Swapping
 * it for a hosted relay or a native-messaging host is how the SAME methods
 * reach a wallet on another surface - and, because the zid session lives above
 * the transport, a session can migrate across transports without re-auth (see
 * the QUIC-style session design, issue linked from the SDK README).
 */

import type { ZafuTransport, ZafuMethod, ZafuRequest, ZafuResponse } from '@zafu/protocol';

/** a detected wallet: its extension origin plus the injected penumbra provider. */
export interface ZafuHandle {
  origin: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the injected penumbra provider is an untyped external object
  provider: any;
}

/** chrome-extension://<id>/ -> <id> */
const extIdFromOrigin = (origin: string): string =>
  origin.replace('chrome-extension://', '').replace(/\/$/, '');

// zid has no @types/chrome; reach the runtime through globalThis so this stays
// dependency-light and does not assume the ambient chrome namespace.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- chrome.runtime is untyped here (no @types/chrome)
const chromeRuntime = (): any => (globalThis as { chrome?: { runtime?: unknown } }).chrome?.runtime;

/**
 * The extension-bridge ZafuTransport. Carries one typed request to the zafu
 * extension and resolves the typed response. Rejects only on transport failure
 * (no wallet, delivery error); an application refusal comes back inside the
 * resolved response as that method's error shape, per @zafu/protocol.
 */
export function createExtensionTransport(handle: ZafuHandle): ZafuTransport {
  const extId = extIdFromOrigin(handle.origin);
  return {
    isAvailable(): Promise<boolean> {
      const rt = chromeRuntime();
      return Promise.resolve(Boolean(handle.origin) && typeof rt?.sendMessage === 'function');
    },
    request<M extends ZafuMethod>(_method: M, req: ZafuRequest<M>): Promise<ZafuResponse<M>> {
      // req already carries `type` (= _method); the wire message is req itself.
      return new Promise<ZafuResponse<M>>((resolve, reject) => {
        const rt = chromeRuntime();
        if (typeof rt?.sendMessage !== 'function') {
          reject(new Error('no zafu wallet reachable (chrome.runtime.sendMessage unavailable)'));
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chrome sendMessage callback arg is untyped
          rt.sendMessage(extId, req, (r: any) => {
            if (rt.lastError) {
              reject(new Error(rt.lastError.message || 'transport error'));
            } else {
              resolve(r as ZafuResponse<M>);
            }
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
  };
}
