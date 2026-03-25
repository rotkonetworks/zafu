/**
 * wallet-entries — side-effectful wallet record creation
 *
 * these functions write to chrome storage (local.set) to create
 * per-network wallet records linked to a vault. no zustand state updates.
 */

import type { ExtensionStorage } from '@repo/storage-chrome/base';
import type { LocalStorageState } from '@repo/storage-chrome/local';
import type { SessionStorageState } from '@repo/storage-chrome/session';
import type { NetworkType, ZignerZafuImport } from './types';
import type { ZcashWalletJson } from '../wallets';
import type { Key } from '@repo/encryption/key';

/** create penumbra wallet entry for a mnemonic vault (side effect: local.set) */
export async function createPenumbraWalletForMnemonic(
  mnemonic: string,
  name: string,
  vaultId: string,
  key: Key,
  local: ExtensionStorage<LocalStorageState>,
): Promise<void> {
  const { generateSpendKey, getFullViewingKey, getWalletId } = await import(
    '@rotko/penumbra-wasm/keys'
  );
  const spendKey = await generateSpendKey(mnemonic);
  const fullViewingKey = await getFullViewingKey(spendKey);
  const walletId = await getWalletId(fullViewingKey);

  const encryptedSeedPhrase = await key.seal(mnemonic);
  const praxWallet = {
    id: walletId.toJsonString(),
    label: name,
    fullViewingKey: fullViewingKey.toJsonString(),
    custody: { encryptedSeedPhrase: encryptedSeedPhrase.toJson() },
    vaultId,
  };

  const wallets = (await local.get('penumbraWallets')) ?? [];
  await local.set('penumbraWallets', [praxWallet, ...wallets]);
  await local.set('activeWalletIndex', 0);
}

/** create wallet entries (penumbra + zcash) for a zigner import (side effect: local.set) */
export async function createZignerWalletEntries(
  data: ZignerZafuImport,
  name: string,
  key: Key,
  vaultId: string,
  supportedNetworks: string[],
  existingVaultCount: number,
  local: ExtensionStorage<LocalStorageState>,
): Promise<NetworkType[]> {
  if (data.fullViewingKey) {
    try {
      const { FullViewingKey } = await import(
        '@penumbra-zone/protobuf/penumbra/core/keys/v1/keys_pb'
      );
      const { getWalletId } = await import('@rotko/penumbra-wasm/keys');

      const fvkBytes = Uint8Array.from(atob(data.fullViewingKey), c => c.charCodeAt(0));
      const fvk = new FullViewingKey({ inner: fvkBytes });
      const walletId = await getWalletId(fvk);

      const metadata = JSON.stringify({
        accountIndex: data.accountIndex,
        importedAt: Date.now(),
        signerType: 'zigner',
      });
      const metadataBox = await key.seal(metadata);

      const praxWallet = {
        id: walletId.toJsonString(),
        label: name,
        fullViewingKey: fvk.toJsonString(),
        custody: { airgapSigner: metadataBox.toJson() },
        vaultId,
      };

      const existingWallets = (await local.get('penumbraWallets')) ?? [];
      await local.set('penumbraWallets', [praxWallet, ...existingWallets]);
      await local.set('activeWalletIndex', 0);
    } catch (e) {
      console.warn('[keyring] failed to create penumbra wallet entry for zigner:', e);
    }
  }

  if (data.viewingKey) {
    try {
      const existingZcashWallets = (await local.get('zcashWallets')) ?? [];
      const zcashWallet = {
        id: `zcash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        label: name,
        orchardFvk: data.viewingKey,
        address: '',
        accountIndex: data.accountIndex,
        mainnet: !data.viewingKey.startsWith('uviewtest'),
        vaultId,
      };
      await local.set('zcashWallets', [zcashWallet, ...existingZcashWallets]);
      await local.set('activeZcashIndex', 0);
    } catch (e) {
      console.warn('[keyring] failed to create zcash wallet entry for zigner:', e);
    }
  }

  const currentEnabled = await local.get('enabledNetworks');
  const networkSet = new Set<string>(currentEnabled ?? []);
  for (const network of supportedNetworks) {
    networkSet.add(network);
  }
  const newEnabledNetworks = [...networkSet] as NetworkType[];
  await local.set('enabledNetworks', newEnabledNetworks);

  if (existingVaultCount === 0 && supportedNetworks.length > 0) {
    await local.set('activeNetwork', supportedNetworks[0] as NetworkType);
  }

  return newEnabledNetworks;
}

/** remove all wallet records linked to a vaultId (side effect: local.set + worker cleanup) */
export async function removeLinkedWallets(
  vaultId: string,
  local: ExtensionStorage<LocalStorageState>,
): Promise<{ removedZcashIds: string[] }> {
  // penumbra wallets
  const wallets = (await local.get('penumbraWallets')) ?? [];
  const updatedWallets = wallets.filter((w: { vaultId?: string }) => w.vaultId !== vaultId);
  if (updatedWallets.length !== wallets.length) {
    await local.set('penumbraWallets', updatedWallets);
    const activeWalletIndex = await local.get('activeWalletIndex') ?? 0;
    if (activeWalletIndex >= updatedWallets.length) {
      await local.set('activeWalletIndex', Math.max(0, updatedWallets.length - 1));
    }
  }

  // zcash wallets
  const zcashWallets = ((await local.get('zcashWallets')) ?? []) as ZcashWalletJson[];
  const removedZcash = zcashWallets.filter(w => w.vaultId === vaultId);
  const updatedZcash = zcashWallets.filter(w => w.vaultId !== vaultId);
  if (updatedZcash.length !== zcashWallets.length) {
    await local.set('zcashWallets', updatedZcash);
    const activeZcashIndex = await local.get('activeZcashIndex') ?? 0;
    if (activeZcashIndex >= updatedZcash.length) {
      await local.set('activeZcashIndex', Math.max(0, updatedZcash.length - 1));
    }
  }

  return { removedZcashIds: removedZcash.map(w => w.id) };
}

/** clean up zcash worker data + birthday key for a vault */
export async function cleanupZcashData(
  vaultId: string,
  removedZcashIds: string[],
): Promise<void> {
  for (const id of removedZcashIds) {
    try {
      const { deleteWalletInWorker } = await import('./network-worker');
      await deleteWalletInWorker('zcash', id);
    } catch {
      // worker may not be running
    }
  }
  try {
    await chrome.storage.local.remove(`zcashBirthday_${vaultId}`);
  } catch {}
}

/** nuke all wallet data — called when last vault is deleted */
export async function nukeAllWalletData(
  session: ExtensionStorage<SessionStorageState>,
  local: ExtensionStorage<LocalStorageState>,
): Promise<void> {
  await session.remove('passwordKey');

  const allLocalKeys = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(allLocalKeys).filter(k =>
    k.startsWith('zcashBirthday_') ||
    k === 'zcashSyncHeight' ||
    k === 'zcashShieldedIndex' ||
    k === 'zcashTransparentIndex' ||
    k === 'fullSyncHeight' ||
    k === 'compactFrontierBlockHeight' ||
    k === 'pendingClaim' ||
    k === 'params'
  );
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }

  try { indexedDB.deleteDatabase('zafu-zcash'); } catch {}
  try { indexedDB.deleteDatabase('zafu-memo-cache'); } catch {}

  await local.set('selectedVaultId', undefined);
  await local.set('penumbraWallets', []);
  await local.set('activeWalletIndex', 0);
  await local.set('zcashWallets', []);
  await local.set('activeZcashIndex', 0);
}
