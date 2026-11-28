import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import type { TestStore } from '..';
import { createMasterKey } from './crypto-ops';
import type { EncryptedVault, ZignerZafuImport } from './types';

/**
 * A profile as zafu made it before #160: a first cold wallet sealed under an
 * empty password, its vault flagged `airgapOnly`. zafu no longer makes these;
 * the tests that move one to a real password build it here.
 */
export const legacyAirgapProfile = async (
  store: TestStore,
  data: ZignerZafuImport,
  name = 'zigner',
): Promise<string> => {
  const created = await createMasterKey('');
  await sessionExtStorage.set('passwordKey', created.keyJson);
  await localExtStorage.set('passwordKeyPrint', created.keyPrint.toJson());
  const id = await store.getState().keyRing.addZignerUnencrypted(data, name);
  const vaults = ((await localExtStorage.get('vaults')) ?? []) as EncryptedVault[];
  await localExtStorage.set(
    'vaults',
    vaults.map(v =>
      v.id === id ? { ...v, insensitive: { ...v.insensitive, airgapOnly: true } } : v,
    ) as never,
  );
  return id;
};
