/**
 * Diversified-address records — encrypted accessors.
 *
 * Each record is `{ diversifierIndex, sharedWith, address, sharedAt }`: the
 * name of a contact, the unique address handed to that contact, and when.
 * Collectively they are the user's payment-referral graph — who they
 * transact with and when they started. In a shielded-pool wallet that is
 * exactly the metadata the pool exists to protect, and it is the kind of
 * thing that identifies a person's associates to anyone who gets the device.
 *
 * The key has always been listed in ENCRYPTED_KEYS, but the two call sites
 * (the contacts screen writing, the inbox screen reading) went through
 * `localExtStorage` directly, which bypasses the encrypting proxy entirely —
 * so the declaration was decorative and the data sat in plaintext. These
 * helpers are the only supported way to touch the key; go through them
 * rather than `localExtStorage`.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncryptedWithMigration, writeEncryptedDirect } from './encrypted-storage';
import type { DiversifiedAddressRecord } from '@repo/wallet/networks/zcash/diversified-address';

/**
 * Read the records, migrating any legacy plaintext value to ciphertext.
 *
 * Returns [] when the wallet is locked — there is no key to decrypt with.
 * Callers must not treat that as "no records exist" and overwrite.
 */
export const getDiversifiedAddresses = async (): Promise<DiversifiedAddressRecord[]> =>
  (await readEncryptedWithMigration<DiversifiedAddressRecord[]>(
    localExtStorage,
    sessionExtStorage,
    'diversifiedAddresses',
  )) ?? [];

/** Write the records, sealed. No-ops with a warning when locked. */
export const setDiversifiedAddresses = async (
  records: DiversifiedAddressRecord[],
): Promise<void> => {
  await writeEncryptedDirect(localExtStorage, sessionExtStorage, 'diversifiedAddresses', records);
};
