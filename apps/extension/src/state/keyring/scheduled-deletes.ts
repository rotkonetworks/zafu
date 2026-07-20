// Scheduled multisig deletion. App-driven multisigs (poker tables) self-evaporate
// after settlement. Storage key `scheduledMultisigDeletes`: { vaultId, deleteAt }[].
// Sweep runs on SW wake; purge is a storage-only mirror of deleteKeyRing.

import { localExtStorage } from '@repo/storage-chrome/local';
import type { EncryptedVault } from './types';
import type { ZcashWalletJson } from '../wallets';

interface ScheduledDelete {
  vaultId: string;
  deleteAt: number;
}

const KEY = 'scheduledMultisigDeletes' as const;

async function getList(): Promise<ScheduledDelete[]> {
  const raw = await chrome.storage.local.get(KEY);
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
  if (filtered.length !== list.length) {
    await setList(filtered);
  }
}

/**
 * DESTRUCTIVE storage-only vault+wallet purge (mirrors deleteKeyRing's storage half without the
 * zustand mutation). ⚠️ For a `frost-multisig` vault this erases the ONLY copy of the key share:
 * it is not seed-recoverable and there is no auto-backup. NEVER wire this to an automatic path
 * (timer / dapp request). Call it only from a user-initiated flow that has already verified the
 * wallet is fully synced AND holds a zero balance (or the user explicitly accepted the loss after
 * exporting a backup). As of the retain-no-autodelete policy this has no automatic callers.
 */
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
      const { deleteWalletInWorker } = await import(/* webpackMode: "eager" */ './network-worker');
      await deleteWalletInWorker('zcash', id);
    } catch {
      /* worker may not be running */
    }
  }
  try {
    await chrome.storage.local.remove(`zcashBirthday_${vaultId}`);
  } catch {}
}

/**
 * Resolve a multisig wallet by name prefix; picks the most recent if
 * multiple match.
 *
 * For destructive lookups (delete, hide, rename) callers MUST pass
 * `requireOrigin` so a malicious site cannot target vaults created by
 * a different origin via a guessed/colliding label prefix. The origin
 * is matched against the `createdByOrigin` field stored on the vault
 * at DKG-join time. Vaults missing that field (pre-hardening creation)
 * are returned only when `requireOrigin` is undefined — the lookup is
 * fail-closed for any caller that asked for origin-scoping.
 */
export async function findVaultByLabelPrefix(
  labelPrefix: string,
  requireOrigin?: string,
): Promise<string | null> {
  if (!labelPrefix) {
    return null;
  }
  const vaults = ((await localExtStorage.get('vaults')) ?? []) as EncryptedVault[];
  const matches = vaults
    .filter(
      v =>
        v.type === 'frost-multisig' && typeof v.name === 'string' && v.name.startsWith(labelPrefix),
    )
    .filter(v => {
      if (requireOrigin === undefined) {
        return true;
      }
      const createdByOrigin = (v.insensitive?.['createdByOrigin'] ?? null) as string | null;
      return createdByOrigin === requireOrigin;
    })
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return matches[0]?.id ?? null;
}

/**
 * Drain any pending scheduled-delete entries WITHOUT destroying vaults.
 *
 * POLICY (money-safety): app-managed multisig vaults (poker tables) are NO LONGER auto-destroyed.
 * A FROST key share is NOT seed-recoverable, has no auto-backup, and lives only in this device's
 * `chrome.storage.local` — so a timer-driven purge is a permanent fund-loss vector (a late deposit
 * to a "settled" table, or an unconfirmed balance the scanner hasn't credited, would be lost). The
 * vaults are a few KB each and already hidden from the UI, so retaining them costs effectively
 * nothing. Removal is now EXCLUSIVELY a user-initiated, balance+sync-gated action in the multisig
 * manager — never an automatic one. This sweep therefore only clears the (now-inert) schedule so
 * legacy entries stop accumulating; it purges nothing.
 */
export async function sweepScheduledDeletes(): Promise<void> {
  const list = await getList();
  if (list.length === 0) {
    return;
  }
  await setList([]); // retain every vault; only clear the inert schedule
}
