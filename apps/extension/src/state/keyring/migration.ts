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
  if (orphans.length === 0) {
    return { vaults, zcashWallets };
  }

  const newVaults = [...vaults];
  const newZcash = [...zcashWallets];

  for (const orphan of orphans) {
    const newVaultId = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const ms = orphan.multisig!;

    let encData = '';
    if (sessionKeyJson) {
      const key = await Key.fromJson(sessionKeyJson);
      const rawKp =
        typeof ms.keyPackage === 'string'
          ? ms.keyPackage
          : ((await key.unseal(Box.fromJson(ms.keyPackage!))) ?? '');
      const rawEs =
        typeof ms.ephemeralSeed === 'string'
          ? ms.ephemeralSeed
          : ((await key.unseal(Box.fromJson(ms.ephemeralSeed!))) ?? '');
      const box = await key.seal(JSON.stringify({ keyPackage: rawKp, ephemeralSeed: rawEs }));
      encData = JSON.stringify(box.toJson());
    } else {
      const rawKp =
        typeof ms.keyPackage === 'string' ? ms.keyPackage : JSON.stringify(ms.keyPackage);
      const rawEs =
        typeof ms.ephemeralSeed === 'string' ? ms.ephemeralSeed : JSON.stringify(ms.ephemeralSeed);
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
    if (idx >= 0) {
      newZcash[idx] = { ...newZcash[idx]!, vaultId: newVaultId };
    }
  }

  await local.set('vaults', newVaults);
  await local.set('zcashWallets', newZcash);

  return { vaults: newVaults, zcashWallets: newZcash };
}

export const hasOrphanedMultisigs = (zcashWallets: ZcashWalletJson[]): boolean =>
  zcashWallets.some(w => w.multisig && !w.vaultId);

/**
 * reconstruct a zcashWallets mirror row from a frost-multisig vault's
 * insensitive metadata. the vault is the source of truth for signing
 * (getMultisigSecrets is vault-first); this rebuilds the display/routing
 * mirror the multisig manager reads. secret material (keyPackage /
 * ephemeralSeed) stays in vault.encryptedData and is intentionally omitted
 * here — self-custody backup pulls it via getMultisigSecrets(vaultId).
 *
 * orchardFvk isn't stored on the vault, so a mirror rebuilt from a vault
 * that never had one carries ''. balances resolve by vaultId regardless;
 * backup export surfaces a clear "unlock the wallet" error if the fvk is
 * genuinely unrecoverable.
 */
export const deriveMirrorFromFrostVault = (vault: EncryptedVault): ZcashWalletJson => {
  const ins = vault.insensitive;
  const custody = ins['custody'] === 'airgapSigner' ? ('airgapSigner' as const) : undefined;
  return {
    id: `zcash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    label: vault.name,
    orchardFvk: (ins['orchardFvk'] as string | undefined) ?? '',
    address: (ins['address'] as string | undefined) ?? '',
    accountIndex: 0,
    mainnet: true,
    vaultId: vault.id,
    multisig: {
      publicKeyPackage: (ins['publicKeyPackage'] as string | undefined) ?? '',
      threshold: (ins['threshold'] as number | undefined) ?? 0,
      maxSigners: (ins['maxSigners'] as number | undefined) ?? 0,
      relayUrl: (ins['relayUrl'] as string | undefined) ?? '',
      ...(custody ? { custody } : {}),
      ...(ins['zignerWalletId'] ? { zignerWalletId: ins['zignerWalletId'] as string } : {}),
      ...(ins['hidden'] === true ? { hidden: true as const } : {}),
    },
  };
};

/**
 * forward reconciliation: ensure every frost-multisig vault has a matching
 * zcashWallets mirror. symmetric with migrateOrphanedMultisigs (which handles
 * the reverse: a mirror with no vault). without this, a frost-multisig vault
 * whose mirror was never written (older builds) or dropped is fully functional
 * for signing but invisible in the multisig manager, which reads only the
 * mirror. returns the (possibly extended) list and whether anything changed.
 */
export const backfillMissingMultisigMirrors = (
  vaults: EncryptedVault[],
  zcashWallets: ZcashWalletJson[],
): { zcashWallets: ZcashWalletJson[]; changed: boolean } => {
  const known = new Set(zcashWallets.map(w => w.vaultId).filter(Boolean));
  const missing = vaults.filter(v => v.type === 'frost-multisig' && !known.has(v.id));
  if (missing.length === 0) {
    return { zcashWallets, changed: false };
  }
  const rebuilt = missing.map(deriveMirrorFromFrostVault);
  return { zcashWallets: [...rebuilt, ...zcashWallets], changed: true };
};
