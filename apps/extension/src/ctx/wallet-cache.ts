/**
 * Shared wallet cache for RPC context getters.
 *
 * The decrypted wallet is set once by the service worker when
 * startWalletServices() resolves. RPC context getters (getFullViewingKey,
 * getWalletId) await walletReady instead of re-decrypting on every call.
 *
 * On wallet switch, resetWalletCache() replaces the promise so new RPC
 * requests block until the new wallet is ready.
 */
import type { WalletJson } from '@repo/wallet';

let resolve: (w: WalletJson) => void;
let reject: (e: Error) => void;
const fresh = () => {
  const p = new Promise<WalletJson>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // a failed cache is a normal state (wrong network, penumbra disabled);
  // don't surface it as an unhandled rejection - RPC getters observe it.
  p.catch(() => undefined);
  return p;
};
let walletReady = fresh();

/** Set the cached wallet  - unblocks all waiting RPC context getters. */
export const setCachedWallet = (wallet: WalletJson | undefined, reason?: string) => {
  if (!wallet) {
    // Never cache `undefined`: getters would throw an opaque
    // "reading 'fullViewingKey' of undefined" to dapps. Fail with the reason.
    reject(new Error(reason ?? 'penumbra wallet not available'));
    return;
  }
  resolve(wallet);
};

/** Reset the cache (wallet switch / reinit). New RPC calls block until setCachedWallet. */
export const resetWalletCache = () => {
  walletReady = fresh();
};

/** Await the decrypted wallet. Used by context getters. */
export const getWalletReady = (): Promise<WalletJson> => walletReady;
