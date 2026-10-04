/* eslint-disable no-console -- CLI output */
import { writeFileSync } from 'node:fs';
import { generateMnemonic } from 'bip39';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { deriveInjectiveWallet } from '@repo/wallet/networks/injective/derive';

/**
 * `feegrant init <file>`: create the granter key ON the host that runs the
 * service. Writes a fresh 24-word mnemonic to <file> with mode 0600, refuses to
 * overwrite an existing file, and prints only the public inj1 address to fund.
 * The mnemonic never leaves the machine and never appears in any output.
 */
export const initGranter = async (file: string | undefined): Promise<void> => {
  if (!file) {
    throw new Error('usage: feegrant init <mnemonic-file>');
  }
  const mnemonic = generateMnemonic(256);
  writeFileSync(file, `${mnemonic}\n`, { mode: 0o600, flag: 'wx' });
  const wallet = await deriveInjectiveWallet(mnemonic, 0);
  wallet.privateKey.fill(0);
  console.log(wallet.address);
};

/**
 * `feegrant init-base <file>`: create the Base gas sponsor key ON the host.
 * Writes a fresh private key to <file> (0600, never overwrites) and prints only
 * the 0x address to fund. Separate from the Injective granter on purpose.
 */
export const initBaseKey = (file: string | undefined): void => {
  if (!file) {
    throw new Error('usage: feegrant init-base <key-file>');
  }
  const key = generatePrivateKey();
  writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
  console.log(privateKeyToAccount(key).address);
};
