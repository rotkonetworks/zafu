/**
 * A zigner pocket's wallet record, from the viewing key the device showed for
 * one of its ZIP 32 accounts. The key must come from the same seed as the
 * wallet (its ZID says so) and name an account this wallet doesn't have yet;
 * zigner then signs as that account (it finds it from the spends).
 */

import type { ZcashWalletJson } from './wallets';

/** what a zigner's `ur:zcash-accounts` export carries (packages/wallet parseZcashUr) */
export interface ScannedAccount {
  ufvk: string;
  accountIndex: number;
  zidPublicKey?: string;
}

/** a zigner vault's public facts (`insensitive`) */
export interface ZignerVaultFacts {
  id: string;
  insensitive: Record<string, unknown>;
}

/** zigner wallets get pockets; keystone, ledger and bare viewing keys stay single-account */
export const isZignerSigner = (insensitive: Record<string, unknown>): boolean =>
  insensitive['coldSignerType'] === undefined || insensitive['coldSignerType'] === 'zigner';

/** the record for the scanned account, or a calm line saying why it can't be one */
export const zignerPocketRecord = (
  vault: ZignerVaultFacts,
  main: Pick<ZcashWalletJson, 'mainnet'>,
  scanned: ScannedAccount,
  accountsHere: readonly number[],
  label: string,
  id: string,
): ZcashWalletJson => {
  if (!isZignerSigner(vault.insensitive)) {
    throw new Error('pockets are for zigner wallets');
  }
  // the ZID is what proves the key is from this wallet's seed; a wallet added
  // before zafu kept it can't tell
  if (typeof vault.insensitive['zid'] !== 'string' || !vault.insensitive['zid']) {
    throw new Error(
      'this zigner wallet was added before zafu kept its identity · please add it again from zigner',
    );
  }
  if (!scanned.zidPublicKey || scanned.zidPublicKey !== vault.insensitive['zid']) {
    throw new Error("that key is from another zigner seed · please show this wallet's key");
  }
  if (accountsHere.includes(scanned.accountIndex)) {
    throw new Error(`account ${scanned.accountIndex} is already a pocket here`);
  }
  const mainnet = !scanned.ufvk.startsWith('uviewtest');
  if (mainnet !== main.mainnet) {
    throw new Error('that key is for another zcash network');
  }
  return {
    id,
    label,
    orchardFvk: scanned.ufvk,
    address: '',
    accountIndex: scanned.accountIndex,
    mainnet,
    vaultId: vault.id,
  };
};
