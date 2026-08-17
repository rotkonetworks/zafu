/**
 * Merge a new zigner import into an existing same-device vault.
 *
 * When a user imports the same zigner device across multiple networks
 * (e.g. first zcash, then penumbra), we want one vault with multiple
 * network capabilities — not one vault per network. This module handles
 * the merge: decrypt the existing vault data, combine the new viewing
 * keys / addresses into it, re-encrypt, and wire up the per-network
 * wallet entries for whatever's newly supported.
 *
 * Identity for "same device" is the ZID pubkey (deterministic from the
 * seed), accompanied by accountIndex. Same (ZID, accountIndex) = same
 * wallet.
 */

import { Key } from '@repo/encryption/key';
import { Box } from '@repo/encryption/box';
import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import type { EncryptedVault, ZignerZafuImport } from './types';
import { buildZignerVault, zignerSupportedNetworks } from './vault-ops';
import { createZignerWalletEntries } from './wallet-entries';

/**
 * Merge `incoming` data into `existing` vault (must be the same zigner device).
 * Re-encrypts the vault with the current session key, updates the vaults list,
 * and creates any missing per-network wallet entries (penumbra / zcash).
 *
 * Returns the vaultId of the merged vault.
 */
export async function mergeZignerCapabilities(
  existing: EncryptedVault,
  incoming: ZignerZafuImport,
  local: ExtensionStorage<LocalStorageState>,
  session: ExtensionStorage<SessionStorageState>,
): Promise<string> {
  // need the session key to decrypt + re-encrypt the vault's import data
  const sessionKeyJson = await session.get('passwordKey');
  if (!sessionKeyJson) {
    throw new Error('keyring locked — cannot merge zigner imports');
  }
  const key = await Key.fromJson(sessionKeyJson);

  // decrypt the existing import data
  const existingBox = Box.fromJson(JSON.parse(existing.encryptedData));
  const existingDataStr = await key.unseal(existingBox);
  if (!existingDataStr) {
    throw new Error('failed to decrypt existing zigner vault');
  }
  const existingData = JSON.parse(existingDataStr) as ZignerZafuImport;

  // merge: keep existing fields, add any non-empty new fields
  const merged: ZignerZafuImport = {
    ...existingData,
    fullViewingKey: incoming.fullViewingKey ?? existingData.fullViewingKey,
    viewingKey: incoming.viewingKey ?? existingData.viewingKey,
    publicKey: incoming.publicKey ?? existingData.publicKey,
    polkadotSs58: incoming.polkadotSs58 ?? existingData.polkadotSs58,
    polkadotGenesisHash: incoming.polkadotGenesisHash ?? existingData.polkadotGenesisHash,
    cosmosAddresses: incoming.cosmosAddresses ?? existingData.cosmosAddresses,
    zidPublicKey: incoming.zidPublicKey ?? existingData.zidPublicKey,
    // accountIndex + deviceId stay as-is (they matched for us to be here)
  };

  // determine which networks are NEW (weren't in the existing vault)
  const existingNetworks = new Set(zignerSupportedNetworks(existingData));
  const mergedNetworks = zignerSupportedNetworks(merged);
  const newlyAddedNetworks = mergedNetworks.filter(n => !existingNetworks.has(n));

  // re-encrypt merged data, rebuild vault entry
  const encryptedBox = await key.seal(JSON.stringify(merged));
  const rebuilt = buildZignerVault(
    existing.id,
    existing.name,
    JSON.stringify(encryptedBox.toJson()),
    merged,
    mergedNetworks,
    { airgapOnly: existing.insensitive['airgapOnly'] === true },
  );
  // preserve original createdAt
  rebuilt.createdAt = existing.createdAt;

  // write back
  const vaults = ((await local.get('vaults')) ?? []) as EncryptedVault[];
  const updated = vaults.map(v => (v.id === existing.id ? rebuilt : v));
  await local.set('vaults', updated);

  // A per-network wallet ENTRY can be missing even when the vault already
  // "supports" that network. Removing a wallet deletes its per-network entry
  // (zcashWallets / penumbraWallets) but does NOT strip the viewing key from
  // the vault's encrypted data - so a later re-import of the same device finds
  // the capability still present, computes an EMPTY newlyAddedNetworks, and
  // skips entry creation entirely. The import then "succeeds" with nothing to
  // show. So we recreate an entry for any supported network whose wallet entry
  // is currently absent, in addition to genuinely-new networks. Checking
  // presence first keeps this dedup-safe (createZignerWalletEntries appends
  // unconditionally, so calling it for a network that already has an entry
  // would duplicate it).
  const zcashWalletsList = ((await local.get('zcashWallets')) ?? []) as { vaultId?: string }[];
  const penumbraWalletsList = ((await local.get('penumbraWallets')) ?? []) as {
    vaultId?: string;
  }[];
  const hasZcashEntry = zcashWalletsList.some(w => w.vaultId === existing.id);
  const hasPenumbraEntry = penumbraWalletsList.some(w => w.vaultId === existing.id);

  const needsEntry = new Set<string>(newlyAddedNetworks);
  if (mergedNetworks.includes('zcash') && merged.viewingKey && !hasZcashEntry) {
    needsEntry.add('zcash');
  }
  if (mergedNetworks.includes('penumbra') && merged.fullViewingKey && !hasPenumbraEntry) {
    needsEntry.add('penumbra');
  }

  // create per-network wallet entries for the networks that need one. Source
  // the keys from `merged` (the vault's authoritative data) rather than
  // `incoming`, since a re-import may re-supply only one network's key while a
  // different network's entry is the one that went missing. Null out the keys
  // for networks that already have an entry so createZignerWalletEntries - which
  // gates penumbra on fullViewingKey and zcash on viewingKey - only creates the
  // missing ones and never duplicates an existing entry.
  if (needsEntry.size > 0) {
    const createData: ZignerZafuImport = {
      ...merged,
      fullViewingKey: needsEntry.has('penumbra') ? merged.fullViewingKey : undefined,
      viewingKey: needsEntry.has('zcash') ? merged.viewingKey : undefined,
    };
    await createZignerWalletEntries(
      createData,
      existing.name,
      key,
      existing.id,
      [...needsEntry],
      updated.length - 1, // count of OTHER vaults (not including this one)
      local,
    );
  }

  return existing.id;
}
