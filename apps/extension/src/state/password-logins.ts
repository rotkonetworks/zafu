/**
 * The passwords tool's saved logins: site, username, length and version, so
 * the form can be filled again. Never the password itself, which is derived
 * fresh from the phrase each time. Sealed at rest, read and written only
 * through these helpers, and carried in the personal-data backup.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncryptedWithMigration, writeEncryptedDirect } from './encrypted-storage';

export interface PasswordLogin {
  /** the wallet whose phrase derives it: its zid, else its vault id */
  owner: string;
  site: string;
  username: string;
  length: number;
  version: number;
  savedAt: number;
}

/** one saved login per wallet, site and username */
const same = (a: PasswordLogin, b: Pick<PasswordLogin, 'owner' | 'site' | 'username'>) =>
  a.owner === b.owner && a.site === b.site && a.username === b.username;

/** Throws when the wallet is locked, so an edit never writes back an empty list. */
export const readPasswordLogins = async (): Promise<PasswordLogin[]> =>
  (await readEncryptedWithMigration<PasswordLogin[]>(
    localExtStorage,
    sessionExtStorage,
    'passwordLogins',
  )) ?? [];

const write = (logins: PasswordLogin[]) =>
  writeEncryptedDirect(localExtStorage, sessionExtStorage, 'passwordLogins', logins);

/** save or update one login; the newest first */
export const savePasswordLogin = async (login: PasswordLogin): Promise<PasswordLogin[]> => {
  const next = [login, ...(await readPasswordLogins()).filter(l => !same(l, login))];
  await write(next);
  return next;
};

export const forgetPasswordLogin = async (
  login: Pick<PasswordLogin, 'owner' | 'site' | 'username'>,
): Promise<PasswordLogin[]> => {
  const next = (await readPasswordLogins()).filter(l => !same(l, login));
  await write(next);
  return next;
};

/** restore from a backup: merge keeps what is here and adds the rest; replace takes the backup */
export const restorePasswordLogins = async (
  logins: unknown,
  mode: 'merge' | 'replace',
): Promise<number> => {
  const valid = (Array.isArray(logins) ? logins : []).filter(
    (l): l is PasswordLogin =>
      !!l &&
      typeof l.owner === 'string' &&
      typeof l.site === 'string' &&
      typeof l.username === 'string' &&
      typeof l.length === 'number' &&
      typeof l.version === 'number',
  );
  const here = mode === 'merge' ? await readPasswordLogins() : [];
  await write([...here, ...valid.filter(l => !here.some(h => same(h, l)))]);
  return valid.length;
};
