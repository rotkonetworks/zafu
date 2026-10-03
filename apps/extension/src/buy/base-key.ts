/**
 * The person's Base address: a burner inside the buy (and later sell) flow,
 * never a network. It is the Injective key (coin type 60, m/44'/60'/0'/0/0):
 * one secp256k1 key, the same 0x address on every EVM chain, derived by the
 * one function Injective already uses. No second derivation.
 *
 * Signing follows the existing hot path (hooks/cosmos-signer.ts): the page
 * asks the keyring for the selected wallet's mnemonic, derives, signs, and
 * zeroes the key. Nothing is stored.
 */

import { deriveEthWallet } from '@repo/wallet/networks/ethereum/derive';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { bytesToHex } from 'viem';

/** account 0: the address Injective shows as 0x, so a person sees one EVM address */
const BASE_ACCOUNT = 0;

export const baseAddressOf = async (mnemonic: string): Promise<`0x${string}`> => {
  const w = await deriveEthWallet(mnemonic, BASE_ACCOUNT);
  w.privateKey.fill(0);
  return w.address as `0x${string}`;
};

/**
 * Run `fn` with a signing account for the Base key, then zero the key bytes.
 * viem keeps its own copy inside the account for the call's lifetime only.
 */
export const withBaseAccount = async <T>(
  mnemonic: string,
  fn: (account: PrivateKeyAccount) => Promise<T>,
): Promise<T> => {
  const w = await deriveEthWallet(mnemonic, BASE_ACCOUNT);
  try {
    const account = privateKeyToAccount(bytesToHex(w.privateKey));
    if (account.address.toLowerCase() !== w.address.toLowerCase()) {
      throw new Error('the base key did not match its address');
    }
    return await fn(account);
  } finally {
    w.privateKey.fill(0);
  }
};
