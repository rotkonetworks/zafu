/**
 * migration — one-time data migrations run during init
 *
 * each migration is a pure-ish function: takes current state,
 * returns new state + writes to storage if needed.
 */

import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import { Key, type KeyJson } from '@repo/encryption/key';
import { Box } from '@repo/encryption/box';
import type { BoxJson } from '@repo/encryption/box';
import type { EncryptedVault } from './types';
import type { ZcashWalletJson } from '../wallets';

/** migrate orphaned multisig wallets (multisig && !vaultId) into the vault system */
export async function migrateOrphanedMultisigs(
  vaults: EncryptedVault[],
  zcashWallets: ZcashWalletJson[],
  sessionKeyJson: KeyJson | undefined,
  local: ExtensionStorage<LocalStorageState>,
): Promise<{ vaults: EncryptedVault[]; zcashWallets: ZcashWalletJson[] }> {
  const orphans = zcashWallets.filter(w => w.multisig && !w.vaultId);
  if (orphans.length === 0) return { vaults, zcashWallets };

  const newVaults = [...vaults];
  const newZcash = [...zcashWallets];

  for (const orphan of orphans) {
    const newVaultId = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const ms = orphan.multisig!;

    let encData = '';
    if (sessionKeyJson) {
      const key = await Key.fromJson(sessionKeyJson);
      const rawKp = typeof ms.keyPackage === 'string'
        ? ms.keyPackage
        : await key.unseal(Box.fromJson(ms.keyPackage as BoxJson)) ?? '';
      const rawEs = typeof ms.ephemeralSeed === 'string'
        ? ms.ephemeralSeed
        : await key.unseal(Box.fromJson(ms.ephemeralSeed as BoxJson)) ?? '';
      const box = await key.seal(JSON.stringify({ keyPackage: rawKp, ephemeralSeed: rawEs }));
      encData = JSON.stringify(box.toJson());
    } else {
      const rawKp = typeof ms.keyPackage === 'string' ? ms.keyPackage : JSON.stringify(ms.keyPackage);
      const rawEs = typeof ms.ephemeralSeed === 'string' ? ms.ephemeralSeed : JSON.stringify(ms.ephemeralSeed);
      encData = JSON.stringify({ keyPackage: rawKp, ephemeralSeed: rawEs });
    }

    const vault: EncryptedVault = {
      id: newVaultId,
      type: 'frost-multisig',
      name: orphan.label,
      createdAt: Date.now(),
      encryptedData: encData,
      salt: '',
      insensitive: {
        publicKeyPackage: ms.publicKeyPackage,
        threshold: ms.threshold,
        maxSigners: ms.maxSigners,
        relayUrl: ms.relayUrl,
        address: orphan.address,
        supportedNetworks: ['zcash'],
      },
    };
    newVaults.push(vault);

    const idx = newZcash.findIndex(w => w.id === orphan.id);
    if (idx >= 0) newZcash[idx] = { ...newZcash[idx]!, vaultId: newVaultId };
  }

  await local.set('vaults', newVaults);
  await local.set('zcashWallets', newZcash);

  return { vaults: newVaults, zcashWallets: newZcash };
}

export const hasOrphanedMultisigs = (zcashWallets: ZcashWalletJson[]): boolean =>
  zcashWallets.some(w => w.multisig && !w.vaultId);
