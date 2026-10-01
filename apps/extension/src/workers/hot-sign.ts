/**
 * Hot (seed) signing for the zcash worker.
 *
 * The page never decrypts the phrase for a zcash spend. It posts the sealed
 * vault box and a decrypt-only, non-extractable copy of the session key
 * (VaultUnlock); this worker unseals the box, turns the phrase straight into a
 * wasm SpendKeys for one ZIP 32 account and frees it when the send ends. The
 * offscreen prover only ever receives that account's UFVK: it builds and
 * proves, and SpendKeys signs here.
 */
import { Box } from '@repo/encryption/box';
import { Key } from '@repo/encryption/key';
import type { VaultUnlock } from '../state/keyring/types';

/** the wasm SpendKeys surface the worker uses (zcli crates/zcash-wasm/src/hot_sign.rs) */
export interface SpendKeys {
  ufvk(): string;
  receiving_address(): string;
  sign_pczt(pcztHex: string): string;
  transparent_pubkey(index: number): string;
  sign_shielding(index: number, unsignedTxHex: string, sighashesJson: string): string;
  free(): void;
}

export type SpendKeysCtor = new (phrase: string, account: number, mainnet: boolean) => SpendKeys;

export const VAULT_LOCKED =
  'this wallet could not be opened just now · please unlock and try again';

/** the phrase, inside this worker only; every failure is the same calm error */
export const unsealVault = async (unlock: VaultUnlock | undefined): Promise<string> => {
  let phrase: string | null = null;
  try {
    phrase = unlock ? await Key.unsealWith(unlock.key, Box.fromJson(JSON.parse(unlock.box))) : null;
  } catch {
    // a malformed box reads exactly like a wrong key
  }
  if (!phrase) {
    throw new Error(VAULT_LOCKED);
  }
  return phrase;
};

/**
 * Run `run` with this account's spend keys, then wipe them. The phrase exists
 * only between the unseal and the SpendKeys constructor.
 */
export const withSpendKeys = async <T>(
  ctor: SpendKeysCtor,
  unlock: VaultUnlock | undefined,
  account: number,
  mainnet: boolean,
  run: (keys: SpendKeys) => Promise<T>,
): Promise<T> => {
  const keys = new ctor(await unsealVault(unlock), account, mainnet);
  try {
    return await run(keys);
  } finally {
    keys.free();
  }
};
