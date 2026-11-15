/**
 * The store, once the keyring has read the vaults from storage.
 *
 * The store loads on its first import (persist.ts runs the keyring's init),
 * and that takes a few storage reads. A service worker Chrome just woke for a
 * site's request reads it before they finish and sees no wallet at all: a
 * passkey sign-in then answered "no zafu credential" and the browser said it
 * had no passkey, unless a zafu window happened to be keeping the worker up.
 */

import { useStore } from '.';

export const keyringLoaded = (): Promise<void> =>
  new Promise(resolve => {
    const loaded = () => useStore.getState().keyRing.status !== 'not-loaded';
    if (loaded()) {
      resolve();
      return;
    }
    const stop = useStore.subscribe(() => {
      if (loaded()) {
        stop();
        resolve();
      }
    });
  });

/** for a handler that reads wallets: the store with its keyring loaded */
export const loadedStore = async (): Promise<typeof useStore> => {
  await keyringLoaded();
  return useStore;
};
