// Scheduled multisig deletion. App-driven multisigs (poker tables) self-evaporate
// after settlement. Storage key `scheduledMultisigDeletes`: { vaultId, deleteAt }[].
// Sweep runs on SW wake; purge is a storage-only mirror of deleteKeyRing.

import { localExtStorage } from '@repo/storage-chrome/local';
import type { EncryptedVault } from './types';
import type { ZcashWalletJson } from '../wallets';

interface ScheduledDelete { vaultId: string; deleteAt: number }

const KEY = 'scheduledMultisigDeletes' as const;

async function getList(): Promise<ScheduledDelete[]> {
  const raw = await (chrome.storage.local.get(KEY));
  return (raw[KEY] as ScheduledDelete[] | undefined) ?? [];
}

async function setList(list: ScheduledDelete[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: list });
}

export async function scheduleMultisigDelete(vaultId: string, deleteAt: number): Promise<void> {
  const list = await getList();
  const filtered = list.filter(e => e.vaultId !== vaultId);
  filtered.push({ vaultId, deleteAt });
  await setList(filtered);
}

export async function cancelScheduledDelete(vaultId: string): Promise<void> {
  const list = await getList();
  const filtered = list.filter(e => e.vaultId !== vaultId);
  if (filtered.length !== list.length) await setList(filtered);
}

/** storage-only vault+wallet purge. mirrors deleteKeyRing's storage half without the zustand mutation */
export async function purgeVault(vaultId: string): Promise<void> {
  const vaults = ((await localExtStorage.get('vaults')) ?? []) as EncryptedVault[];
  const updatedVaults = vaults.filter(v => v.id !== vaultId);
  if (updatedVaults.length !== vaults.length) {
    await localExtStorage.set('vaults', updatedVaults);
  }

  const zcashWallets = ((await localExtStorage.get('zcashWallets')) ?? []) as ZcashWalletJson[];
  const removedIds = zcashWallets.filter(w => w.vaultId === vaultId).map(w => w.id);
  const updatedZcash = zcashWallets.filter(w => w.vaultId !== vaultId);
  if (updatedZcash.length !== zcashWallets.length) {
    await localExtStorage.set('zcashWallets', updatedZcash);
    const activeZcashIndex = (await localExtStorage.get('activeZcashIndex')) ?? 0;
    if (activeZcashIndex >= updatedZcash.length) {
      await localExtStorage.set('activeZcashIndex', Math.max(0, updatedZcash.length - 1));
    }
  }

  for (const id of removedIds) {
    try {
      const { deleteWalletInWorker } = await import('./network-worker');
      await deleteWalletInWorker('zcash', id);
    } catch { /* worker may not be running */ }
  }
  try { await chrome.storage.local.remove(`zcashBirthday_${vaultId}`); } catch {}
}

/** Resolve a multisig wallet by name prefix; picks the most recent if multiple match. */
export async function findVaultByLabelPrefix(labelPrefix: string): Promise<string | null> {
  if (!labelPrefix) return null;
  const vaults = ((await localExtStorage.get('vaults')) ?? []) as EncryptedVault[];
  const matches = vaults
    .filter(v => v.type === 'frost-multisig' && typeof v.name === 'string' && v.name.startsWith(labelPrefix))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return matches[0]?.id ?? null;
}

/** Scan scheduled-deletes and purge anything past its deleteAt. Safe to call from anywhere. */
export async function sweepScheduledDeletes(): Promise<void> {
  const list = await getList();
  if (list.length === 0) return;
  const now = Date.now();
  const expired = list.filter(e => e.deleteAt <= now);
  if (expired.length === 0) return;
  const remaining = list.filter(e => e.deleteAt > now);
  await setList(remaining);
  for (const e of expired) {
    try { await purgeVault(e.vaultId); } catch { /* tolerate */ }
  }
}
