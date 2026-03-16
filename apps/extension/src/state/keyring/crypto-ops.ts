/**
 * crypto-ops — async crypto helpers
 *
 * each function does exactly one thing. no storage writes, no state updates.
 * takes a session handle (to get the password key) + inputs, returns outputs.
 */

import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import { Key } from '@repo/encryption/key';
import { KeyPrint, type KeyPrintJson } from '@repo/encryption/key-print';
import { Box } from '@repo/encryption/box';
import type { BoxJson } from '@repo/encryption/box';
import type { EncryptedVault } from './types';

export interface CryptoCtx {
  session: ExtensionStorage<SessionStorageState>;
}

/** get the current encryption key from session, or throw */
export const requireKey = async (ctx: CryptoCtx): Promise<Key> => {
  const keyJson = await ctx.session.get('passwordKey');
  if (!keyJson) throw new Error('keyring locked');
  return Key.fromJson(keyJson);
};

/** encrypt plaintext with the session key */
export const encrypt = async (ctx: CryptoCtx, plaintext: string): Promise<string> => {
  const key = await requireKey(ctx);
  const box = await key.seal(plaintext);
  return JSON.stringify(box.toJson());
};

/** decrypt a vault's encrypted data with the session key */
export const decryptVault = async (ctx: CryptoCtx, vault: EncryptedVault): Promise<string> => {
  const key = await requireKey(ctx);
  const box = Box.fromJson(JSON.parse(vault.encryptedData));
  const decrypted = await key.unseal(box);
  if (!decrypted) throw new Error('failed to decrypt vault');
  return decrypted;
};

/** create a new master key from password */
export const createMasterKey = async (password: string) => {
  const { key, keyPrint } = await Key.create(password);
  const keyJson = await key.toJson();
  return { key, keyPrint, keyJson };
};

/** recreate master key from password + keyprint. returns null on wrong password */
export const recreateMasterKey = async (password: string, keyPrintJson: KeyPrintJson) => {
  const key = await Key.recreate(password, KeyPrint.fromJson(keyPrintJson));
  if (!key) return null;
  const keyJson = await key.toJson();
  return { key, keyJson };
};

/** re-encrypt vault data: decrypt with oldKey, encrypt with newKey */
export const reencryptVault = async (
  vault: EncryptedVault,
  oldKey: Key,
  newKey: Key,
): Promise<EncryptedVault> => {
  const oldBox = Box.fromJson(JSON.parse(vault.encryptedData));
  const decrypted = await oldKey.unseal(oldBox);
  if (!decrypted) throw new Error(`failed to decrypt vault ${vault.id}`);

  const newBox = await newKey.seal(decrypted);
  const newInsensitive = { ...vault.insensitive };
  delete newInsensitive['airgapOnly'];

  return {
    ...vault,
    encryptedData: JSON.stringify(newBox.toJson()),
    insensitive: newInsensitive,
  };
};

/** decrypt multisig secrets — tries vault first, then legacy zcash wallet record */
export const decryptMultisigSecrets = async (
  ctx: CryptoCtx,
  keyPackage: BoxJson | string,
  ephemeralSeed: BoxJson | string,
): Promise<{ keyPackage: string; ephemeralSeed: string }> => {
  if (typeof keyPackage === 'string' && typeof ephemeralSeed === 'string') {
    return { keyPackage, ephemeralSeed };
  }
  const key = await requireKey(ctx);
  return {
    keyPackage: await key.unseal(Box.fromJson(keyPackage as BoxJson)) as string,
    ephemeralSeed: await key.unseal(Box.fromJson(ephemeralSeed as BoxJson)) as string,
  };
};

/** encrypt FROST key material for storage in a zcash wallet record */
export const encryptFrostSecrets = async (
  ctx: CryptoCtx,
  keyPackage: string,
  ephemeralSeed: string,
): Promise<{ encKeyPackage: BoxJson | string; encEphemeralSeed: BoxJson | string }> => {
  try {
    const key = await requireKey(ctx);
    return {
      encKeyPackage: (await key.seal(keyPackage)).toJson(),
      encEphemeralSeed: (await key.seal(ephemeralSeed)).toJson(),
    };
  } catch {
    // no session key — store as raw strings
    return { encKeyPackage: keyPackage, encEphemeralSeed: ephemeralSeed };
  }
};
