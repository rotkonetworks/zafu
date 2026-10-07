/**
 * Which wallet made a passkey for which relying party, and from which origin.
 * A site may only ask to sign in to an rpId it created a passkey for there,
 * so `a.example.com` cannot sign for `example.com` unless it made that passkey
 * itself. Sealed at rest and carried in the personal-data backup.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncryptedWithMigration, writeEncryptedDirect } from './encrypted-storage';

export interface PasskeyGrant {
  origin: string;
  rpId: string;
  /** the wallet that consented: its zid, else its vault id */
  owner: string;
  at: number;
}

const same = (a: PasskeyGrant, b: Omit<PasskeyGrant, 'at'>) =>
  a.origin === b.origin && a.rpId === b.rpId && a.owner === b.owner;

/** Throws when the wallet is locked, so an edit never writes back an empty list. */
export const readPasskeyGrants = async (): Promise<PasskeyGrant[]> =>
  (await readEncryptedWithMigration<PasskeyGrant[]>(
    localExtStorage,
    sessionExtStorage,
    'passkeyGrants',
  )) ?? [];

const write = (grants: PasskeyGrant[]) =>
  writeEncryptedDirect(localExtStorage, sessionExtStorage, 'passkeyGrants', grants);

/** remember (or refresh) one grant, newest first */
export const recordPasskeyGrant = async (g: Omit<PasskeyGrant, 'at'>): Promise<void> => {
  await write([{ ...g, at: Date.now() }, ...(await readPasskeyGrants()).filter(x => !same(x, g))]);
};

/**
 * The wallets that may answer a sign-in from `origin` for `rpId`, newest
 * first. `undefined` means the origin has no recorded grant at all: a passkey
 * made before grants were recorded, which the caller may still offer once.
 */
export const ownersFor = (
  grants: readonly PasskeyGrant[],
  origin: string,
  rpId: string,
): string[] | undefined => {
  const here = grants.filter(g => g.origin === origin);
  return here.length ? here.filter(g => g.rpId === rpId).map(g => g.owner) : undefined;
};

/** restore from a backup: merge keeps what is here and adds the rest; replace takes the backup */
export const restorePasskeyGrants = async (
  grants: unknown,
  mode: 'merge' | 'replace',
): Promise<void> => {
  const valid = (Array.isArray(grants) ? grants : []).filter(
    (g): g is PasskeyGrant =>
      !!g &&
      typeof g.origin === 'string' &&
      typeof g.rpId === 'string' &&
      typeof g.owner === 'string' &&
      typeof g.at === 'number',
  );
  const here = mode === 'merge' ? await readPasskeyGrants() : [];
  await write([...here, ...valid.filter(g => !here.some(h => same(h, g)))]);
};
