/**
 * What zafu contacted lately: per destination, how many times on each of the
 * last seven days and when last. Kept on this computer only, sealed under the
 * session key; it never leaves the device and is not in the backup.
 *
 * Counts only. No url, path, payload, txid or address is ever stored: the key
 * is the egress destination id (or the bare host for a host the user allowed
 * one by one), and the screen looks up its label and hosts at render time.
 *
 * The service worker is the one writer. Every realm tallies its own allowed
 * requests and hands a batch over the egress channel (`./egress`); batches
 * collect here and are written at most once per {@link FLUSH_MS}. Locked, the
 * write is skipped and the batch waits for the next one.
 */

import { Box } from '@repo/encryption/box';
import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { getKey, isEncryptedWrapper, readEncrypted } from '../state/encrypted-storage';
import { keyUse } from '../state/keyring-lock';
import type { ContactTally } from './egress';

export const CONTACTED_KEY = 'netContacted';
const KEY = CONTACTED_KEY as keyof LocalStorageState;
export const KEEP_DAYS = 7;
const DAY_MS = 86_400_000;
const FLUSH_MS = 15_000;

export interface ContactedEntry {
  /** epoch ms of the latest contact */
  last: number;
  /** count per day, keyed by days since the epoch */
  days: Record<string, number>;
}

/** keyed by destination id, or by host when no destination owns it */
export type ContactedLog = Record<string, ContactedEntry>;

export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

const count = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** a stored log, keeping only well-formed counts */
export const parseContacted = (raw: unknown): ContactedLog => {
  const out: ContactedLog = {};
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  for (const [id, e] of Object.entries(raw as Record<string, Partial<ContactedEntry>>)) {
    const days = Object.entries(e?.days ?? {}).filter(([d, n]) => /^\d+$/.test(d) && count(n));
    if (count(e?.last) && days.length) {
      out[id] = { last: e.last, days: Object.fromEntries(days) as Record<string, number> };
    }
  }
  return out;
};

/** a and b added together, day by day */
export const mergeContacted = (a: ContactedLog, b: ContactedLog): ContactedLog => {
  const out: ContactedLog = structuredClone(a);
  for (const [id, e] of Object.entries(b)) {
    const into = (out[id] ??= { last: 0, days: {} });
    into.last = Math.max(into.last, e.last);
    for (const [d, n] of Object.entries(e.days)) {
      into.days[d] = (into.days[d] ?? 0) + n;
    }
  }
  return out;
};

/** the days older than {@link KEEP_DAYS} dropped, and any destination left with none */
export const pruneContacted = (log: ContactedLog, now: number): ContactedLog => {
  const oldest = dayOf(now) - KEEP_DAYS + 1;
  const out: ContactedLog = {};
  for (const [id, e] of Object.entries(log)) {
    const days = Object.entries(e.days).filter(([d]) => Number(d) >= oldest);
    if (days.length) {
      out[id] = { last: e.last, days: Object.fromEntries(days) };
    }
  }
  return out;
};

/** one realm's tally as a log */
export const fromTally = (tally: ContactTally): ContactedLog =>
  Object.fromEntries(
    Object.entries(tally).map(([id, t]) => [id, { last: t.at, days: { [dayOf(t.at)]: t.n } }]),
  );

let pending: ContactedLog = {};
let timer: ReturnType<typeof setTimeout> | undefined;

/** merged into the sealed log under the key it is read with; false while locked */
const write = (batch: ContactedLog, now: number): Promise<boolean> =>
  keyUse(async () => {
    const key = await getKey(sessionExtStorage);
    if (!key) {
      return false;
    }
    const raw = await localExtStorage.get(KEY);
    // a box this key cannot open (an older password's) starts the log afresh
    const plain = isEncryptedWrapper(raw)
      ? await key.unseal(Box.fromJson(raw.encrypted)).catch(() => null)
      : null;
    const next = pruneContacted(
      mergeContacted(parseContacted(plain ? JSON.parse(plain) : null), batch),
      now,
    );
    await localExtStorage.set(KEY, { encrypted: (await key.seal(JSON.stringify(next))).toJson() });
    return true;
  });

export const flushContacted = async (now = Date.now()): Promise<void> => {
  timer = undefined;
  const batch = pending;
  pending = {};
  if (!Object.keys(batch).length) {
    return;
  }
  const ok = await write(batch, now).catch(() => false);
  if (!ok) {
    pending = pruneContacted(mergeContacted(batch, pending), now);
  }
};

/** a batch from any realm, written soon */
export const noteContacted = (tally: ContactTally): void => {
  pending = mergeContacted(pending, fromTally(tally));
  timer ??= setTimeout(() => void flushContacted(), FLUSH_MS);
};

/** the last seven days; empty while locked or never written */
export const readContacted = async (now = Date.now()): Promise<ContactedLog> =>
  pruneContacted(
    parseContacted(await readEncrypted(localExtStorage, sessionExtStorage, KEY).catch(() => null)),
    now,
  );

/** "clear this list": the stored log, and whatever this realm had not written yet */
export const clearContacted = async (): Promise<void> => {
  pending = {};
  await localExtStorage.remove(KEY);
};
