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

  // create per-network wallet entries ONLY for the newly-added networks.
  // createZignerWalletEntries reads from `incoming` so we pass just the
  // new-network slice. existingVaultCount is based on the updated list.
  if (newlyAddedNetworks.length > 0) {
    await createZignerWalletEntries(
      incoming,
      existing.name,
      key,
      existing.id,
      newlyAddedNetworks,
      updated.length - 1, // count of OTHER vaults (not including this one)
      local,
    );
  }

  return existing.id;
}
