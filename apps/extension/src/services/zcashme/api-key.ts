/**
 * The person's own zcash.me api key, sealed at rest under its own storage key.
 * The rest of the config stays plain: the egress policy reads its mode and
 * mirror url in every realm, locked or not.
 */

import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncrypted, writeEncryptedDirect } from '../../state/encrypted-storage';

const KEY = 'zcashMeApiKey' as keyof LocalStorageState;

/** move a key an older version kept inside the plain config to its sealed place */
export const sealZcashMeApiKey = async (): Promise<void> => {
  const config = await localExtStorage.get('zcashMeConfig');
  if (!config?.apiKey) {
    return;
  }
  // locked, the key stays where it is until the next unlock
  if (await writeEncryptedDirect(localExtStorage, sessionExtStorage, KEY, config.apiKey)) {
    await localExtStorage.set('zcashMeConfig', { ...config, apiKey: '' });
  }
};

/** the key, or '' while locked or when there is none */
export const readZcashMeApiKey = async (): Promise<string> => {
  await sealZcashMeApiKey();
  const key = await readEncrypted<unknown>(localExtStorage, sessionExtStorage, KEY);
  return typeof key === 'string' ? key : '';
};

/** false while locked: nothing was written */
export const writeZcashMeApiKey = async (apiKey: string): Promise<boolean> => {
  if (apiKey) {
    return writeEncryptedDirect(localExtStorage, sessionExtStorage, KEY, apiKey);
  }
  await localExtStorage.remove(KEY);
  return true;
};
