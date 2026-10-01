/**
 * The destination ledger: the user's own decisions about where zafu may
 * connect, plus the short audit trail of what it declined to contact.
 *
 *  - `destinations` is keyed by `host` (hostname, plus port when the URL carries
 *    a non-default one): a node on a nonstandard port is a distinct destination.
 *    `state` is a decision, never a guess: `allowed` and `blocked` are the
 *    user's per-host override, `pending` means asked and not answered (or
 *    merely recorded). Nothing is ever born `allowed`: whether a host with no
 *    override may be contacted is the policy's call (`./egress-policy`), from
 *    the networks and services the user has turned on.
 *  - `optIns` is the per-destination choice (`zcash-me`, `chat-relay`, ...):
 *    `allowed` turns an optional service on, `blocked` turns any destination
 *    off, including one an enabled network requires.
 *  - `v` is the ledger format. v2 dropped the old "trusted hosts are born
 *    allowed" rule; `./egress-migrate` upgrades a v1 ledger once.
 */

import { parseNetPurpose, type NetPurpose } from './purpose';

export type DestinationState = 'pending' | 'allowed' | 'blocked';
export type OptInChoice = 'allowed' | 'blocked';

export type EgressOutcome =
  | 'allowed'
  | 'blocked'
  | 'consent-required'
  | 'feature-disabled'
  | 'error';

export interface DestinationRecord {
  state: DestinationState;
  /** one line the settings list can show - where this host came from */
  label: string;
  purposes: NetPurpose[];
  firstSeen: number;
  /**
   * When a consent prompt was raised for this host and left unanswered. This
   * is what makes the prompt raise-once across service-worker restarts.
   */
  promptedAt?: number;
  lastOutcome?: EgressOutcome;
}

export interface NetEgressState {
  /** 1 until `./egress-migrate` has run; kept as read so a write never fakes the migration */
  v: 1 | 2;
  destinations: Record<string, DestinationRecord>;
  optIns: Record<string, OptInChoice>;
}

export const EMPTY_NET_EGRESS: NetEgressState = Object.freeze({
  v: 1,
  destinations: Object.freeze({}) as Record<string, DestinationRecord>,
  optIns: Object.freeze({}) as Record<string, OptInChoice>,
});

/**
 * The audit trail. Bounded, and transitions only: a refusal, a consent
 * prompt, an answer - never every request.
 */
export interface NetEgressLogEntry {
  ts: number;
  host: string;
  purpose: NetPurpose;
  outcome: EgressOutcome;
  /** short, human-readable context; never a full URL with query parameters */
  detail?: string;
}

/** Kept small enough that rendering it in settings never janks. */
export const NET_EGRESS_LOG_LIMIT = 200;

const isState = (raw: unknown): raw is DestinationState =>
  raw === 'pending' || raw === 'allowed' || raw === 'blocked';

const isOutcome = (raw: unknown): raw is EgressOutcome =>
  raw === 'allowed' ||
  raw === 'blocked' ||
  raw === 'consent-required' ||
  raw === 'feature-disabled' ||
  raw === 'error';

const num = (raw: unknown, fallback = 0): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;

const entries = (raw: unknown): [string, Record<string, unknown>][] =>
  typeof raw === 'object' && raw !== null
    ? Object.entries(raw as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? [[k, v as Record<string, unknown>]] : [],
      )
    : [];

/**
 * Storage is written by several realms and by older builds across an upgrade,
 * so it is parsed rather than trusted. A malformed entry is dropped, not
 * repaired: a destination whose state we cannot read must not silently become
 * `allowed`. The `v` read here is what the migration keys off; a missing one
 * is a v1 ledger (see `./egress-migrate`).
 */
export const parseNetEgressState = (raw: unknown): NetEgressState => {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const destinations: Record<string, DestinationRecord> = {};
  for (const [host, v] of entries(obj['destinations'])) {
    if (!isState(v['state'])) {
      continue;
    }
    const purposes = Array.isArray(v['purposes']) ? v['purposes'] : [];
    destinations[host] = {
      state: v['state'],
      label: typeof v['label'] === 'string' ? v['label'] : '',
      purposes: purposes.map(parseNetPurpose),
      firstSeen: num(v['firstSeen']),
      promptedAt: typeof v['promptedAt'] === 'number' ? v['promptedAt'] : undefined,
      lastOutcome: isOutcome(v['lastOutcome']) ? v['lastOutcome'] : undefined,
    };
  }
  const optIns: Record<string, OptInChoice> = {};
  for (const [id, choice] of Object.entries((obj['optIns'] as Record<string, unknown>) ?? {})) {
    if (choice === 'allowed' || choice === 'blocked') {
      optIns[id] = choice;
    }
  }
  return { v: obj['v'] === 2 ? 2 : 1, destinations, optIns };
};

/**
 * The network key for a URL: hostname, plus the port when it is not the one the
 * scheme implies. Returns undefined for inputs that are not absolute network
 * URLs - a `data:`/`blob:`/extension-internal fetch is not a destination and
 * must not be gated.
 */
export const hostOf = (input: string | URL | Request): string | undefined => {
  let url: URL;
  try {
    if (typeof input === 'string') {
      url = new URL(input);
    } else if (input instanceof URL) {
      url = input;
    } else if (typeof Request !== 'undefined' && input instanceof Request) {
      url = new URL(input.url);
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }

  // Not a remote destination: no host to consent to, nothing leaves the machine.
  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:' &&
    url.protocol !== 'ws:' &&
    url.protocol !== 'wss:'
  ) {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const defaultPort = url.protocol === 'http:' || url.protocol === 'ws:' ? '80' : '443';
  const port = url.port === '' ? defaultPort : url.port;
  return port === defaultPort ? hostname : `${hostname}:${port}`;
};

/** The bracket-free hostname part of a destination key. */
export const hostnameOf = (host: string): string => host.split(':')[0] ?? host;

/**
 * A device on this machine is not a third party: the ledger/speculos bridge and
 * a locally run node cannot be reached by anyone else and cannot see anything
 * that has not already left zafu. Gating them would be pure friction, and the
 * prompt would have to explain why zafu is asking permission to talk to itself.
 */
export const isLocalDeviceHost = (host: string): boolean => {
  // IPv6 loopback is written `::1`, `[::1]` or with a port. It cannot go
  // through `hostnameOf`, which splits on ':' and would read `::1` as ''.
  if (/^(::1|\[::1\])(:\d+)?$/.test(host)) {
    return true;
  }
  const name = hostnameOf(host);
  return name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0';
};

export const parseNetEgressLog = (raw: unknown): NetEgressLogEntry[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: NetEgressLogEntry[] = [];
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v['host'] !== 'string' || typeof v['ts'] !== 'number') {
      continue;
    }
    const outcome = v['outcome'];
    if (!isOutcome(outcome)) {
      continue;
    }
    entries.push({
      ts: v['ts'],
      host: v['host'],
      purpose: parseNetPurpose(v['purpose']),
      outcome,
      detail: typeof v['detail'] === 'string' ? v['detail'] : undefined,
    });
  }
  return entries;
};
