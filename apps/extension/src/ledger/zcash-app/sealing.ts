/**
 * Storage + sealing for Ledger checkpoints, kept free of worker/UI imports so
 * the keyring (password change) can re-seal checkpoints without pulling the
 * send flow into the service worker bundle.
 */

import { Box } from '@repo/encryption/box';
import { Key } from '@repo/encryption/key';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import type { KeyValueArea, Sealer } from './operations-store';

/** chrome.storage.local as a KeyValueArea. */
export const chromeLocalArea: KeyValueArea = {
  get: async key => (await chrome.storage.local.get(key))[key],
  set: async (key, value) => chrome.storage.local.set({ [key]: value }),
};

/** Seal with a specific wallet Key (password change re-seal). */
export const keySealer = (key: Key): Sealer => ({
  seal: async plain => JSON.stringify((await key.seal(plain)).toJson()),
  unseal: async sealed => {
    const plain = await key.unseal(Box.fromJson(JSON.parse(sealed)));
    if (plain === null) {
      throw new Error('wrong key');
    }
    return plain;
  },
});

/** Seal with the session key - the key that seals the vaults. Locked -> throws. */
export const sessionKeySealer: Sealer = {
  seal: async plain => {
    const keyJson = await sessionExtStorage.get('passwordKey');
    if (!keyJson) {
      throw new Error('keyring locked');
    }
    return keySealer(await Key.fromJson(keyJson)).seal(plain);
  },
  unseal: async sealed => {
    const keyJson = await sessionExtStorage.get('passwordKey');
    if (!keyJson) {
      throw new Error('keyring locked');
    }
    return keySealer(await Key.fromJson(keyJson)).unseal(sealed);
  },
};
