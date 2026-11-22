/**
 * Which wallet made a passkey for which relying party, and from which origin.
 * As WebAuthn has it, a passkey belongs to its rpId: any page that may claim
 * that rpId (the rpId's own host or a subdomain of it) may ask to sign in with
 * it, and every sign-in still takes the person's answer on zafu's screen. The
 * signed client data names the asking page, so the relying party sees who
 * asked. Sealed at rest and carried in the personal-data backup.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncryptedWithMigration, writeEncryptedDirect } from './encrypted-storage';

export interface PasskeyGrant {
  origin: string;
  rpId: string;
  /** the wallet that consented: its zid, else its vault id */
  owner: string;
  /**
   * the account's user id (hex), for a passkey made per account: what lets a
   * sign-in with no credential list (usernameless) find it again
   */
  userId?: string;
  at: number;
}

const same = (a: PasskeyGrant, b: Omit<PasskeyGrant, 'at'>) =>
  a.origin === b.origin && a.rpId === b.rpId && a.owner === b.owner && a.userId === b.userId;

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
 * The grants that may answer a sign-in from `origin` for `rpId`, newest
 * first: this origin's own, else those made for the same rpId from another
 * origin. WebAuthn scopes a passkey to its rpId, not to the page that made it,
 * and sites do make it on one subdomain and sign in on another; the caller has
 * checked that `origin` may claim `rpId`. `undefined` means nothing is recorded
 * for either: a passkey made before grants were recorded, which the caller may
 * still offer once.
 */
export const grantsFor = (
  grants: readonly PasskeyGrant[],
  origin: string,
  rpId: string,
): PasskeyGrant[] | undefined => {
  const forRp = grants.filter(g => g.rpId === rpId);
  const here = forRp.filter(g => g.origin === origin);
  if (here.length || forRp.length) {
    return here.length ? here : forRp;
  }
  return grants.some(g => g.origin === origin) ? [] : undefined;
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
      (g.userId === undefined || typeof g.userId === 'string') &&
      typeof g.at === 'number',
  );
  const here = mode === 'merge' ? await readPasskeyGrants() : [];
  await write([...here, ...valid.filter(g => !here.some(h => same(h, g)))]);
};
