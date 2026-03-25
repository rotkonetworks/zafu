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
let walletReady = new Promise<WalletJson>(r => { resolve = r; });

/** Set the cached wallet  - unblocks all waiting RPC context getters. */
export const setCachedWallet = (wallet: WalletJson) => {
  resolve(wallet);
};

/** Reset the cache (wallet switch / reinit). New RPC calls block until setCachedWallet. */
export const resetWalletCache = () => {
  walletReady = new Promise<WalletJson>(r => { resolve = r; });
};

/** Await the decrypted wallet. Used by context getters. */
export const getWalletReady = (): Promise<WalletJson> => walletReady;
