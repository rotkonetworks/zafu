/**
 * "Yours": your own addresses on other chains (your bitcoin refund address,
 * your ethereum wallet), per zafu wallet, so a swap field can offer them
 * again. Sealed at rest, read and written only through these helpers, and
 * carried in the personal-data backup. zafu's own zcash, penumbra and burner
 * addresses are never stored here: they are derived where they are shown.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncryptedWithMigration, writeEncryptedDirect } from './encrypted-storage';
import { isAddressOn, type AddressChain } from '../addresses/kind';

export interface YourAddress {
  /** the zafu wallet it belongs with: its zid, else its vault id (pocketOwner) */
  owner: string;
  chain: AddressChain;
  address: string;
  savedAt: number;
}

const same = (a: YourAddress, b: Pick<YourAddress, 'owner' | 'chain' | 'address'>) =>
  a.owner === b.owner && a.chain === b.chain && a.address === b.address;

/** an entry that really is an address on its chain; a zid or garbage never is */
const valid = (a: unknown): a is YourAddress => {
  const y = a as YourAddress | null;
  return (
    !!y &&
    typeof y.owner === 'string' &&
    typeof y.chain === 'string' &&
    typeof y.address === 'string' &&
    typeof y.savedAt === 'number' &&
    isAddressOn(y.address, y.chain)
  );
};

/** Throws when the wallet is locked, so an edit never writes back an empty list. */
export const readYourAddresses = async (): Promise<YourAddress[]> =>
  (
    (await readEncryptedWithMigration<YourAddress[]>(
      localExtStorage,
      sessionExtStorage,
      'yourAddresses',
    )) ?? []
  ).filter(valid);

const write = (list: YourAddress[]) =>
  writeEncryptedDirect(localExtStorage, sessionExtStorage, 'yourAddresses', list);

/** this wallet's addresses on one chain, the newest first */
export const yoursOn = (list: readonly YourAddress[], owner: string, chain: AddressChain) =>
  list.filter(y => y.owner === owner && y.chain === chain);

/** remember one, the newest first; refuses anything that is not an address on its chain */
export const rememberYourAddress = async (
  entry: Omit<YourAddress, 'savedAt'>,
): Promise<YourAddress[]> => {
  const next = { ...entry, address: entry.address.trim(), savedAt: Date.now() };
  if (!valid(next)) {
    throw new Error(`not a ${entry.chain} address`);
  }
  const list = [next, ...(await readYourAddresses()).filter(y => !same(y, next))];
  await write(list);
  return list;
};

export const forgetYourAddress = async (
  entry: Pick<YourAddress, 'owner' | 'chain' | 'address'>,
): Promise<YourAddress[]> => {
  const list = (await readYourAddresses()).filter(y => !same(y, entry));
  await write(list);
  return list;
};

/** restore from a backup: merge keeps what is here and adds the rest; replace takes the backup */
export const restoreYourAddresses = async (
  backup: unknown,
  mode: 'merge' | 'replace',
): Promise<number> => {
  const got = (Array.isArray(backup) ? backup : []).filter(valid);
  const here = mode === 'merge' ? await readYourAddresses() : [];
  await write([...here, ...got.filter(y => !here.some(h => same(h, y)))]);
  return got.length;
};
