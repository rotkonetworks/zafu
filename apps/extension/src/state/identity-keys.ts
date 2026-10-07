/**
 * The identity node passkeys and passwords derive from, one per wallet, held
 * in session storage for the length of an unlock. It is the HMAC chain's
 * `identity` (identityKey), not the phrase: it reproduces every password and
 * passkey ever made, and cannot reach a spending key (those come from the
 * BIP39 seed, which this chain never touches). The phrase is decrypted once,
 * at unlock or on first use, and never again by these features.
 */
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { identityKey } from './identity';

/** a fresh copy of `vaultId`'s identity node; the caller may zeroize it */
export const getIdentityKey = async (
  vaultId: string,
  getMnemonic: (vaultId: string) => Promise<string>,
): Promise<Uint8Array> => {
  const held = (await sessionExtStorage.get('identityKeys')) ?? {};
  const hex = held[vaultId];
  if (hex) {
    return hexToBytes(hex);
  }
  const identity = identityKey(await getMnemonic(vaultId));
  await sessionExtStorage.set('identityKeys', { ...held, [vaultId]: bytesToHex(identity) });
  return identity;
};
