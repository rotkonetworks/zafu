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
import { CONTACTED_CLEAR, type ContactTally } from './egress';

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
  /**
   * how many of each day's went over nym; absent means all direct, as every
   * log written before nym routing is
   */
  nym?: Record<string, number>;
}

/** keyed by destination id, or by host when no destination owns it */
export type ContactedLog = Record<string, ContactedEntry>;

export const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

const count = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** an entry from its day counts, the nym map left out when nothing went over nym */
const entry = (
  last: number,
  days: [string, number][],
  nym: [string, number][] = [],
): ContactedEntry =>
  nym.length
    ? { last, days: Object.fromEntries(days), nym: Object.fromEntries(nym) }
    : { last, days: Object.fromEntries(days) };

/** a stored log, keeping only well-formed counts, with never more over nym than in all */
export const parseContacted = (raw: unknown): ContactedLog => {
  const out: ContactedLog = {};
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  for (const [id, e] of Object.entries(raw as Record<string, Partial<ContactedEntry>>)) {
    const days = Object.entries(e?.days ?? {}).filter(([d, n]) => /^\d+$/.test(d) && count(n));
    const all = Object.fromEntries(days) as Record<string, number>;
    const nym = Object.entries(e?.nym ?? {}).filter(([d, n]) => count(n) && n <= (all[d] ?? 0));
    if (count(e?.last) && days.length) {
      out[id] = entry(e.last, days, nym);
    }
  }
  return out;
};

const add = (into: Record<string, number>, from: Record<string, number> = {}) => {
  for (const [d, n] of Object.entries(from)) {
    into[d] = (into[d] ?? 0) + n;
  }
  return into;
};

/** a and b added together, day by day */
export const mergeContacted = (a: ContactedLog, b: ContactedLog): ContactedLog => {
  const out: ContactedLog = structuredClone(a);
  for (const [id, e] of Object.entries(b)) {
    const into = (out[id] ??= { last: 0, days: {} });
    into.last = Math.max(into.last, e.last);
    add(into.days, e.days);
    if (e.nym) {
      into.nym = add(into.nym ?? {}, e.nym);
    }
  }
  return out;
};

/** the days older than {@link KEEP_DAYS} dropped, and any destination left with none */
export const pruneContacted = (log: ContactedLog, now: number): ContactedLog => {
  const oldest = dayOf(now) - KEEP_DAYS + 1;
  const kept = (m: Record<string, number> = {}) =>
    Object.entries(m).filter(([d]) => Number(d) >= oldest);
  const out: ContactedLog = {};
  for (const [id, e] of Object.entries(log)) {
    const days = kept(e.days);
    if (days.length) {
      out[id] = entry(e.last, days, kept(e.nym));
    }
  }
  return out;
};

/** one realm's tally as a log */
export const fromTally = (tally: ContactTally): ContactedLog =>
  Object.fromEntries(
    Object.entries(tally).map(([id, t]) => {
      const d = String(dayOf(t.at));
      return [id, entry(t.at, [[d, t.n]], t.nym ? [[d, t.nym]] : [])];
    }),
  );

const sum = (m: Record<string, number> = {}) => Object.values(m).reduce((a, b) => a + b, 0);

/** an entry's week: all contacts, and how many of them went over nym */
export const totalContacted = (e: ContactedEntry): { n: number; nym: number } => ({
  n: sum(e.days),
  nym: sum(e.nym),
});

const parseJson = (s: string | null): unknown => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

let pending: ContactedLog = {};
let timer: ReturnType<typeof setTimeout> | undefined;
/** bumped by a clear, so a write already under way drops its batch instead of bringing it back */
let generation = 0;

/** merged into the sealed log under the key it is read with; false while locked */
const write = (batch: ContactedLog, now: number, gen: number): Promise<boolean> =>
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
    const next = pruneContacted(mergeContacted(parseContacted(parseJson(plain)), batch), now);
    const sealed = (await key.seal(JSON.stringify(next))).toJson();
    // a clear that landed while this write was sealing wins
    if (gen === generation) {
      await localExtStorage.set(KEY, { encrypted: sealed });
    }
    return true;
  });

export const flushContacted = async (now = Date.now()): Promise<void> => {
  timer = undefined;
  const batch = pending;
  pending = {};
  if (!Object.keys(batch).length) {
    return;
  }
  const gen = generation;
  const ok = await write(batch, now, gen).catch(() => false);
  if (!ok && gen === generation) {
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

/** the stored log, and whatever this realm had not written yet */
export const clearContacted = async (): Promise<void> => {
  generation++;
  pending = {};
  clearTimeout(timer);
  timer = undefined;
  await keyUse(() => localExtStorage.remove(KEY));
};

/**
 * "clear this list" from a screen: the service worker, the one writer, drops
 * its unwritten counts first, so nothing it held comes back on its next write.
 */
export const clearContactedEverywhere = async (): Promise<void> => {
  await Promise.resolve(chrome.runtime.sendMessage({ type: CONTACTED_CLEAR })).catch(
    () => undefined,
  );
  await clearContacted();
};
