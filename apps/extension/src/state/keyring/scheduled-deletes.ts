// Scheduled multisig deletion. App-driven multisigs (poker tables) self-evaporate
// after settlement. Storage key `scheduledMultisigDeletes`: { vaultId, deleteAt }[].
// Sweep runs on SW wake (see sweepScheduledDeletes - it purges nothing today,
// per the retain-no-autodelete policy below).

import { localExtStorage } from '@repo/storage-chrome/local';
import type { EncryptedVault } from './types';

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
