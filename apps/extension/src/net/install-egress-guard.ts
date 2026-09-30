/**
 * Route the worker's outbound `fetch` through the egress gate.
 *
 * Patched at the global rather than at each call site because the callers are
 * libraries (connect-web transports, the block processors, the asset registry)
 * that zafu does not own and cannot thread a guard through. One hook means a new
 * dependency cannot open a new hole by forgetting to opt in, which is the whole
 * point of a wallet-level egress policy.
 *
 * This module must stay cheap and free of transitively wasm-backed imports: MV3
 * only sees a service worker's listeners when they are registered during the
 * worker's initial synchronous evaluation, and a heavy import here - like the
 * one in `install-global-error-handlers.ts` - would defer that registration. The
 * gate is therefore loaded lazily on the first request, inside the (already
 * async) fetch call.
 *
 * Scope: `fetch` only. The extension's other egress - WebSocket - is used
 * exclusively for zafu's own relays (zid delivery, multisig coordination), all
 * of which are in the inventory, and Keplr compat has no surface that can
 * introduce a WebSocket destination. A future WebSocket egress would need the
 * same gate; there is no such path to gate today.
 */

const nativeFetch = globalThis.fetch.bind(globalThis);

let gate: Promise<typeof import('./guard')> | undefined;

const guardedFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  gate ??= import('./guard');
  const { gateEgress, egressRefusalMessage } = await gate;
  const decision = await gateEgress(input);
  if (!decision.allow) {
    // A network-shaped error, so existing `catch` paths keep working and the
    // caller can attach the message to whatever the user sees.
    throw new TypeError(egressRefusalMessage(decision.reason, decision.host));
  }
  return nativeFetch(input, init);
};

export const installEgressGuard = (): void => {
  if (globalThis.fetch === guardedFetch) {
    return;
  }
  globalThis.fetch = guardedFetch;
};
