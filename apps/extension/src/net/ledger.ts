/**
 * Read/write for the destination ledger and its audit trail.
 *
 * Two shapes, two write policies, because they have opposite traffic profiles:
 *
 *  - The ledger is decision-critical. It is read on the egress path (once per
 *    realm, then cached) and written immediately whenever a *decision* changes.
 *  - Request counters are not decision-critical. They ride along in memory and
 *    are flushed on a debounce with a read-modify-write, so a request loop
 *    cannot turn into a storage write per request, and a concurrent decision
 *    written by another realm (the popup answering a prompt) cannot be clobbered
 *    by a counter flush.
 *  - The audit trail records transitions, not requests: `recordOutcome` writes a
 *    line only when the outcome differs from the host's last recorded outcome.
 *    A dapp polling a refused host produces one line, not thousands.
 *
 * The cache is invalidated by `chrome.storage.onChanged` so a decision taken in
 * the popup or the side panel is visible to the worker on its next request. The
 * listener is optional: unit tests and a non-extension runtime simply never
 * invalidate.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import {
  NET_EGRESS_LOG_LIMIT,
  parseNetEgressLog,
  parseNetEgressState,
  type DestinationRecord,
  type DestinationState,
  type NetEgressLogEntry,
  type NetEgressState,
} from './destination';
import type { NetPurpose } from './purpose';

const LEDGER_KEY = 'netEgress' as const;
const LOG_KEY = 'netEgressLog' as const;

/** How long counters may sit in memory before hitting storage. */
const COUNTER_FLUSH_MS = 2000;

let cache: NetEgressState | undefined;
let logCache: NetEgressLogEntry[] | undefined;

/** serialises every write so a read-modify-write pair cannot interleave */
let chain: Promise<unknown> = Promise.resolve();

/** in-memory host -> counter deltas awaiting a flush */
const pendingCounters = new Map<
  string,
  { calls: number; lastUsed: number; purposes: NetPurpose[] }
>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** same-tick guard against raising two prompts for one host */
const promptedThisSession = new Set<string>();

const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  // keep the chain alive even when a link rejects
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

const subscribeToExternalWrites = (): void => {
  // `chrome.storage` is absent in tests; the cache simply never invalidates.
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) {
    return;
  }
  onChanged.addListener(
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local') {
        return;
      }
      if (changes[LEDGER_KEY] !== undefined) {
        cache = undefined;
      }
      if (changes[LOG_KEY] !== undefined) {
        logCache = undefined;
      }
    },
  );
};

subscribeToExternalWrites();

export const readNetEgress = async (): Promise<NetEgressState> => {
  if (cache) {
    return cache;
  }
  cache = parseNetEgressState(await localExtStorage.get(LEDGER_KEY));
  return cache;
};

export const readNetEgressLog = async (): Promise<NetEgressLogEntry[]> => {
  if (logCache) {
    return logCache;
  }
  logCache = parseNetEgressLog(await localExtStorage.get(LOG_KEY));
  return logCache;
};

/** read-modify-write the ledger under the exclusive chain */
const mutateNetEgress = <T>(fn: (state: NetEgressState) => T): Promise<T> =>
  runExclusive(async () => {
    const state = parseNetEgressState(await localExtStorage.get(LEDGER_KEY));
    const result = fn(state);
    await localExtStorage.set(LEDGER_KEY, state);
    cache = state;
    return result;
  });

const flushCounters = (): void => {
  flushTimer = undefined;
  if (pendingCounters.size === 0) {
    return;
  }
  const batch = new Map(pendingCounters);
  pendingCounters.clear();
  void mutateNetEgress(state => {
    for (const [host, delta] of batch) {
      const record = state.destinations[host];
      // The record can be gone if another realm dropped it; nothing to add to.
      if (!record) {
        continue;
      }
      record.calls += delta.calls;
      record.lastUsed = Math.max(record.lastUsed, delta.lastUsed);
      for (const purpose of delta.purposes) {
        if (!record.purposes.includes(purpose)) {
          record.purposes.push(purpose);
        }
      }
    }
  }).catch(() => {
    // Storage failures must not fail the request that is already in flight.
  });
};

const scheduleFlush = (): void => {
  if (flushTimer !== undefined) {
    return;
  }
  flushTimer = setTimeout(flushCounters, COUNTER_FLUSH_MS);
  // never hold the worker awake just to write counters
  (flushTimer as unknown as { unref?: () => void }).unref?.();
};

const bumpCounters = (host: string, purpose: NetPurpose): void => {
  const delta = pendingCounters.get(host) ?? { calls: 0, lastUsed: 0, purposes: [] };
  delta.calls += 1;
  delta.lastUsed = Date.now();
  if (!delta.purposes.includes(purpose)) {
    delta.purposes.push(purpose);
  }
  pendingCounters.set(host, delta);
  scheduleFlush();
};

/** What the caller knows about a host before any decision has been recorded. */
export interface DestinationObservation {
  purpose: NetPurpose;
  /**
   * A user-legible reason to already be approved exists (zafu's own config for
   * an enabled network, or the user configured this host). Trusted hosts are
   * born `allowed`; untrusted ones are born undecided.
   */
  trusted: boolean;
  label: string;
}

/**
 * Record that zafu is about to contact `host`, creating the entry on first
 * contact. Returns the record as it stands *before* this request's decision, so
 * the caller can run the policy against it.
 */
export const noteDestination = async (
  host: string,
  observation: DestinationObservation,
): Promise<DestinationRecord> => {
  const state = await readNetEgress();
  const existing = state.destinations[host];
  if (existing) {
    const known = existing.purposes.includes(observation.purpose);
    if (
      !known ||
      existing.label !== observation.label ||
      existing.trusted !== observation.trusted
    ) {
      // The purpose list is user-facing ("what is this host for"), so a new
      // purpose is worth an immediate write; the counters are not.
      await mutateNetEgress(s => {
        const record = s.destinations[host];
        if (!record) {
          return;
        }
        if (!record.purposes.includes(observation.purpose)) {
          record.purposes.push(observation.purpose);
        }
        // Trust is monotone: a host that is trusted once stays trusted, and a
        // host that was never trusted is not promoted by a later observation.
        if (observation.trusted) {
          record.trusted = true;
          record.label = observation.label;
          if (record.state === 'pending') {
            record.state = 'allowed';
          }
        }
      });
      return (await readNetEgress()).destinations[host] ?? existing;
    }
    bumpCounters(host, observation.purpose);
    return existing;
  }

  const now = Date.now();
  const record: DestinationRecord = {
    state: observation.trusted ? 'allowed' : 'pending',
    trusted: observation.trusted,
    label: observation.label,
    purposes: [observation.purpose],
    firstSeen: now,
    lastUsed: now,
    calls: 1,
    lastOutcome: undefined,
  };
  await mutateNetEgress(s => {
    // A concurrent realm may have created it first; that record wins.
    if (!s.destinations[host]) {
      s.destinations[host] = record;
    }
  });
  const stored = (await readNetEgress()).destinations[host];
  return stored ?? record;
};

/** The user's answer (or a retraction of one). Clears any open-prompt marker. */
export const setDestinationDecision = async (
  host: string,
  state: DestinationState,
): Promise<void> => {
  promptedThisSession.delete(host);
  await mutateNetEgress(s => {
    const record = s.destinations[host];
    if (!record) {
      return;
    }
    record.state = state;
    record.promptedAt = undefined;
    if (state === 'pending') {
      record.lastOutcome = undefined;
    }
  });
};

/**
 * Drop a destination entirely.
 *
 * Used when the reason a host was trusted disappears - the user removed the
 * network they had configured. A stale `allowed` record would keep trusting a
 * host that nothing vouches for anymore, and would keep the removed endpoint
 * listed in the audit trail as if it were still in use, so the record goes with
 * the reason for it.
 */
export const forgetDestination = async (host: string): Promise<boolean> => {
  promptedThisSession.delete(host);
  pendingCounters.delete(host);
  return mutateNetEgress(s => {
    if (!s.destinations[host]) {
      return false;
    }
    delete s.destinations[host];
    return true;
  });
};

/** Mark that a consent prompt was raised for `host` and is unanswered. */
export const markPrompted = async (host: string): Promise<void> => {
  await mutateNetEgress(s => {
    const record = s.destinations[host];
    if (record) {
      record.promptedAt = Date.now();
    }
  });
};

/**
 * Raise-once: true when a prompt should be opened for this host. Durable across
 * service-worker restarts via `promptedAt`, and cheap-deduped within a session.
 */
export const shouldPrompt = async (host: string): Promise<boolean> => {
  if (promptedThisSession.has(host)) {
    return false;
  }
  const record = (await readNetEgress()).destinations[host];
  if (record?.promptedAt !== undefined) {
    return false;
  }
  promptedThisSession.add(host);
  return true;
};

/** Record an outcome, writing an audit line only when it is a transition. */
export const recordOutcome = async (
  host: string,
  purpose: NetPurpose,
  outcome: NonNullable<DestinationRecord['lastOutcome']>,
  detail?: string,
): Promise<void> => {
  const current = (await readNetEgress()).destinations[host];
  if (current?.lastOutcome === outcome) {
    bumpCounters(host, purpose);
    return;
  }
  bumpCounters(host, purpose);
  await runExclusive(async () => {
    const state = parseNetEgressState(await localExtStorage.get(LEDGER_KEY));
    const record = state.destinations[host];
    if (record) {
      record.lastOutcome = outcome;
    }

    const rawLog = parseNetEgressLog(await localExtStorage.get(LOG_KEY));
    const entry: NetEgressLogEntry = {
      ts: Date.now(),
      host,
      purpose,
      outcome,
      detail,
    };
    // newest first, bounded
    const nextLog = [entry, ...rawLog].slice(0, NET_EGRESS_LOG_LIMIT);
    await localExtStorage.set(LOG_KEY, nextLog);
    logCache = nextLog;
    await localExtStorage.set(LEDGER_KEY, state);
    cache = state;
  });
};

/** Assign an identity (proxy/headers) to a destination. */
export const setDestinationIdentity = async (host: string, identityId?: string): Promise<void> => {
  await mutateNetEgress(s => {
    const record = s.destinations[host];
    if (!record) {
      return;
    }
    record.identity = identityId;
  });
};

/** Drop the extra audit trail (the "forget" button in settings). */
export const clearNetEgressLog = async (): Promise<void> => {
  await runExclusive(async () => {
    await localExtStorage.set(LOG_KEY, []);
    logCache = [];
  });
};
