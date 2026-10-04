/**
 * Read/write for the destination ledger (`netEgress`) and its audit trail
 * (`netEgressLog`). Shapes live in `./destination`.
 *
 * Writes are decisions and transitions only - a user's allow/block, an opt-in,
 * a prompt raised, a refusal that differs from the host's last one - never one
 * write per request. Every write is a read-modify-write under one chain, so two
 * realms answering at once cannot clobber each other within a realm, and the
 * cache is dropped on `chrome.storage.onChanged` so a decision taken in the
 * popup is what the worker reads next.
 */

import { localExtStorage } from '@repo/storage-chrome/local';
import {
  NET_EGRESS_LOG_LIMIT,
  parseNetEgressLog,
  parseNetEgressState,
  type DestinationState,
  type EgressOutcome,
  type NetEgressLogEntry,
  type NetEgressState,
  type OptInChoice,
} from './destination';
import type { EgressRefusal } from './egress';
import type { NetPurpose } from './purpose';

const LEDGER_KEY = 'netEgress' as const;
const LOG_KEY = 'netEgressLog' as const;

let cache: NetEgressState | undefined;
let logCache: NetEgressLogEntry[] | undefined;

/** serialises every write so a read-modify-write pair cannot interleave */
let chain: Promise<unknown> = Promise.resolve();

/** same-tick guard against raising two prompts for one host */
const promptedThisSession = new Set<string>();

const runExclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }
  if (changes[LEDGER_KEY] !== undefined) {
    cache = undefined;
  }
  if (changes[LOG_KEY] !== undefined) {
    logCache = undefined;
  }
});

export const readNetEgress = async (): Promise<NetEgressState> =>
  (cache ??= parseNetEgressState(await localExtStorage.get(LEDGER_KEY)));

export const readNetEgressLog = async (): Promise<NetEgressLogEntry[]> =>
  (logCache ??= parseNetEgressLog(await localExtStorage.get(LOG_KEY)));

/** read-modify-write the ledger under the exclusive chain */
const mutateNetEgress = <T>(fn: (state: NetEgressState) => T): Promise<T> =>
  runExclusive(async () => {
    const state = parseNetEgressState(await localExtStorage.get(LEDGER_KEY));
    const result = fn(state);
    await localExtStorage.set(LEDGER_KEY, state);
    cache = state;
    return result;
  });

/**
 * The user's decision on a host (or a retraction: `pending`). Creates the
 * record when the host was never seen, and clears any open-prompt marker.
 */
export const setDestinationDecision = async (
  host: string,
  state: DestinationState,
  meta: { label?: string; purpose?: NetPurpose } = {},
): Promise<void> => {
  promptedThisSession.delete(host);
  await mutateNetEgress(s => {
    const record = (s.destinations[host] ??= {
      state,
      label: meta.label ?? '',
      purposes: [],
      firstSeen: Date.now(),
    });
    record.state = state;
    record.promptedAt = undefined;
    if (meta.label) {
      record.label = meta.label;
    }
    if (meta.purpose && !record.purposes.includes(meta.purpose)) {
      record.purposes.push(meta.purpose);
    }
    if (state === 'pending') {
      record.lastOutcome = undefined;
    }
  });
};

/** Turn a destination on (`allowed`), off (`blocked`), or back to its default (undefined). */
export const setDestinationOptIn = async (
  destination: string,
  choice: OptInChoice | undefined,
): Promise<void> => {
  await mutateNetEgress(s => {
    if (choice) {
      s.optIns[destination] = choice;
    } else {
      delete s.optIns[destination];
    }
  });
};

/**
 * Drop a destination entirely - used when the reason for it disappears (the
 * user removed the network they had configured).
 */
export const forgetDestination = async (host: string): Promise<boolean> => {
  promptedThisSession.delete(host);
  return mutateNetEgress(s => {
    if (!s.destinations[host]) {
      return false;
    }
    delete s.destinations[host];
    return true;
  });
};

/**
 * Raise-once: true when a prompt should be opened for this host, and marks it
 * prompted. Durable across service-worker restarts via `promptedAt`.
 */
export const claimPrompt = async (host: string, purpose: NetPurpose): Promise<boolean> => {
  if (promptedThisSession.has(host)) {
    return false;
  }
  promptedThisSession.add(host);
  if ((await readNetEgress()).destinations[host]?.promptedAt !== undefined) {
    return false;
  }
  await mutateNetEgress(s => {
    const record = (s.destinations[host] ??= {
      state: 'pending',
      label: '',
      purposes: [purpose],
      firstSeen: Date.now(),
    });
    record.promptedAt = Date.now();
  });
  return true;
};

/** Record an outcome, writing an audit line only when it is a transition. */
export const recordOutcome = async (
  host: string,
  purpose: NetPurpose,
  outcome: EgressOutcome,
  detail?: string,
): Promise<void> => {
  if ((await readNetEgress()).destinations[host]?.lastOutcome === outcome) {
    return;
  }
  await runExclusive(async () => {
    const state = parseNetEgressState(await localExtStorage.get(LEDGER_KEY));
    const record = state.destinations[host];
    if (record) {
      record.lastOutcome = outcome;
    }
    const entry: NetEgressLogEntry = { ts: Date.now(), host, purpose, outcome, detail };
    const nextLog = [entry, ...parseNetEgressLog(await localExtStorage.get(LOG_KEY))].slice(
      0,
      NET_EGRESS_LOG_LIMIT,
    );
    await localExtStorage.set(LOG_KEY, nextLog);
    logCache = nextLog;
    if (record) {
      await localExtStorage.set(LEDGER_KEY, state);
      cache = state;
    }
  });
};

/**
 * A refusal from any realm, into the audit trail: what the settings list
 * shows as "zafu did not contact". Deduped against the host's last line, and
 * against the same refusal repeating within a session (a sync loop hitting a
 * blocked host must not become a storage write per attempt).
 */
const refusedThisSession = new Set<string>();
export const recordRefusal = async (refusal: EgressRefusal): Promise<void> => {
  const key = `${refusal.host}|${refusal.reason}`;
  if (refusedThisSession.has(key) || refusal.reason === 'not-ready') {
    return;
  }
  refusedThisSession.add(key);
  await recordOutcome(
    refusal.host,
    'other',
    refusal.reason === 'blocked' ? 'blocked' : 'feature-disabled',
    refusal.destination ? `${refusal.destination}: ${refusal.reason}` : refusal.reason,
  );
};

/** Drop the audit trail (the "forget" button in settings). */
export const clearNetEgressLog = async (): Promise<void> => {
  await runExclusive(async () => {
    await localExtStorage.set(LOG_KEY, []);
    logCache = [];
  });
};

/** The user's egress decisions, for the encrypted personal-data backup. */
export interface EgressChoices {
  hosts: Record<string, OptInChoice>;
  optIns: Record<string, OptInChoice>;
}

export const exportEgressChoices = async (): Promise<EgressChoices> => {
  const state = await readNetEgress();
  const hosts: Record<string, OptInChoice> = {};
  for (const [host, record] of Object.entries(state.destinations)) {
    if (record.state !== 'pending') {
      hosts[host] = record.state;
    }
  }
  return { hosts, optIns: { ...state.optIns } };
};

/** Restore backed-up decisions over the current ones (a restore is the user choosing again). */
export const importEgressChoices = async (
  choices: Partial<EgressChoices> | undefined,
): Promise<void> => {
  const parsed = parseNetEgressState({
    destinations: Object.fromEntries(
      Object.entries(choices?.hosts ?? {}).map(([host, state]) => [
        host,
        { state, label: 'restored from backup' },
      ]),
    ),
    optIns: choices?.optIns,
  });
  await mutateNetEgress(s => {
    for (const [host, record] of Object.entries(parsed.destinations)) {
      s.destinations[host] = {
        ...record,
        firstSeen: s.destinations[host]?.firstSeen ?? Date.now(),
      };
    }
    Object.assign(s.optIns, parsed.optIns);
  });
};
