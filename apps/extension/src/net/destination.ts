/**
 * The destination ledger: every host zafu has ever contacted, what it was for,
 * and whether the user allowed it.
 *
 * Shape notes:
 *
 *  - A destination is keyed by `host` (hostname plus port when the URL carries a
 *    non-default one). Ports are part of the key because a user running their own
 *    node on a nonstandard port is a distinct destination from the default one,
 *    and coalescing them would let an approved default endpoint cover an
 *    unapproved local one.
 *  - `state` is a decision, never a guess: `pending` means the request was
 *    refused and the user has not answered yet. Absence from the map is not
 *    `pending` - it is "never seen", which the policy turns into a prompt (or a
 *    refusal, see `trusted`).
 *  - `trusted` marks a host that already has a user-legible reason to be
 *    approved: it ships in zafu's own config for an enabled network, or the user
 *    configured it themselves (a custom endpoint, the relay url, a local
 *    device). Trusted hosts are never prompted for - asking the user to approve
 *    the node they just typed into settings is theatre, and a fresh install
 *    would get a prompt storm for zafu's own defaults. Untrusted hosts are the
 *    ones that arrived from outside (a dapp advertising an endpoint, a remote
 *    registry), which is precisely the surface the Keplr-compat / transparent
 *    chain feature opens.
 *  - Purposes accumulate so the settings list can say what a host is for, and a
 *    new purpose on an already-allowed host is recorded without re-asking: the
 *    user's decision was about the host, and re-prompting per purpose would be a
 *    prompt storm for `chain-rpc` -> `indexer` on the same node.
 */

import { parseNetPurpose, type NetPurpose } from './purpose';

export type DestinationState = 'pending' | 'allowed' | 'blocked';

/** How zafu looks to a host: the proxy it goes through and/or the headers it sends. */
export interface NetIdentity {
  /** stable id referenced by destinations */
  id: string;
  /** what the user calls it in settings */
  name: string;
  /** proxy to route this destination through; absent means "however the browser is configured" */
  proxy?: {
    scheme: 'socks5' | 'http' | 'https';
    host: string;
    port: number;
    /** credentials for the proxy, stored alongside - a proxy without auth is the common case */
    username?: string;
    password?: string;
  };
  /** extra request headers (a per-endpoint API key, a relay bearer token) */
  headers?: Record<string, string>;
}

export interface DestinationRecord {
  state: DestinationState;
  /** ships in zafu's config for an enabled network, is user-configured, or is a local device */
  trusted: boolean;
  /** one line the settings list can show - where this host came from */
  label: string;
  purposes: NetPurpose[];
  firstSeen: number;
  lastUsed: number;
  calls: number;
  /** identity id, when the user assigned one to this destination */
  identity?: string;
  /**
   * When a consent prompt was raised for this host and left unanswered. Absent
   * means "never asked" (or asked and answered, which clears it). This is what
   * makes the prompt raise-once across service-worker restarts: the in-memory
   * dedupe cannot survive a restart, and a restart during an open prompt is
   * routine.
   */
  promptedAt?: number;
  lastOutcome?: 'allowed' | 'blocked' | 'consent-required' | 'feature-disabled' | 'error';
}

export interface NetEgressState {
  destinations: Record<string, DestinationRecord>;
  identities: Record<string, NetIdentity>;
}

export const EMPTY_NET_EGRESS: NetEgressState = Object.freeze({
  destinations: Object.freeze({}) as Record<string, DestinationRecord>,
  identities: Object.freeze({}) as Record<string, NetIdentity>,
});

/**
 * The audit trail. Bounded, and deliberately not every call: routine requests to
 * an already-allowed host are counted in the ledger, while the events that need a
 * human explanation - first contact, a refusal, a consent prompt, an error - get
 * a line. That keeps this from being a per-request storage write on the hot path.
 */
export interface NetEgressLogEntry {
  ts: number;
  host: string;
  purpose: NetPurpose;
  outcome: 'allowed' | 'blocked' | 'consent-required' | 'feature-disabled' | 'error';
  /** short, human-readable context; never a full URL with query parameters */
  detail?: string;
}

/** Kept small enough that rendering it in settings never janks. */
export const NET_EGRESS_LOG_LIMIT = 200;

const isState = (raw: unknown): raw is DestinationState =>
  raw === 'pending' || raw === 'allowed' || raw === 'blocked';

const isOutcome = (raw: unknown): raw is NonNullable<DestinationRecord['lastOutcome']> =>
  raw === 'allowed' ||
  raw === 'blocked' ||
  raw === 'consent-required' ||
  raw === 'feature-disabled' ||
  raw === 'error';

const num = (raw: unknown, fallback = 0): number =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;

/**
 * Storage is written by several realms (worker, popup, side panel) and by older
 * builds across an upgrade, so it is parsed rather than trusted. A malformed
 * entry is dropped, not repaired: a destination whose state we cannot read must
 * not silently become `allowed`.
 */
export const parseNetEgressState = (raw: unknown): NetEgressState => {
  // A fresh, mutable empty state: the constant is frozen and must not be handed
  // to a caller that is about to record a destination into it.
  if (typeof raw !== 'object' || raw === null) return { destinations: {}, identities: {} };
  const obj = raw as Record<string, unknown>;

  const destinations: Record<string, DestinationRecord> = {};
  const rawDestinations = obj['destinations'];
  if (typeof rawDestinations === 'object' && rawDestinations !== null) {
    for (const [host, value] of Object.entries(rawDestinations as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      if (!isState(v['state'])) continue;
      const purposes = Array.isArray(v['purposes']) ? v['purposes'] : [];
      destinations[host] = {
        state: v['state'],
        trusted: v['trusted'] === true,
        label: typeof v['label'] === 'string' ? v['label'] : '',
        purposes: purposes.map(parseNetPurpose),
        firstSeen: num(v['firstSeen']),
        lastUsed: num(v['lastUsed']),
        calls: num(v['calls']),
        identity: typeof v['identity'] === 'string' ? v['identity'] : undefined,
        promptedAt: typeof v['promptedAt'] === 'number' ? v['promptedAt'] : undefined,
        lastOutcome: isOutcome(v['lastOutcome']) ? v['lastOutcome'] : undefined,
      };
    }
  }

  const identities: Record<string, NetIdentity> = {};
  const rawIdentities = obj['identities'];
  if (typeof rawIdentities === 'object' && rawIdentities !== null) {
    for (const [id, value] of Object.entries(rawIdentities as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      if (typeof v['name'] !== 'string') continue;
      const proxyRaw = v['proxy'];
      let proxy: NetIdentity['proxy'];
      if (typeof proxyRaw === 'object' && proxyRaw !== null) {
        const p = proxyRaw as Record<string, unknown>;
        const scheme = p['scheme'];
        if (
          typeof p['host'] === 'string' &&
          typeof p['port'] === 'number' &&
          (scheme === 'socks5' || scheme === 'http' || scheme === 'https')
        ) {
          proxy = {
            scheme,
            host: p['host'],
            port: p['port'],
            username: typeof p['username'] === 'string' ? p['username'] : undefined,
            password: typeof p['password'] === 'string' ? p['password'] : undefined,
          };
        }
      }
      const headersRaw = v['headers'];
      const headers: Record<string, string> = {};
      if (typeof headersRaw === 'object' && headersRaw !== null) {
        for (const [k, hv] of Object.entries(headersRaw as Record<string, unknown>)) {
          if (typeof hv === 'string') headers[k] = hv;
        }
      }
      identities[id] = {
        id,
        name: v['name'],
        proxy,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
    }
  }

  return { destinations, identities };
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
  if (/^(::1|\[::1\])(:\d+)?$/.test(host)) return true;
  const name = hostnameOf(host);
  return name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0';
};

export const parseNetEgressLog = (raw: unknown): NetEgressLogEntry[] => {
  if (!Array.isArray(raw)) return [];
  const entries: NetEgressLogEntry[] = [];
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v['host'] !== 'string' || typeof v['ts'] !== 'number') continue;
    const outcome = v['outcome'];
    if (
      outcome !== 'allowed' &&
      outcome !== 'blocked' &&
      outcome !== 'consent-required' &&
      outcome !== 'feature-disabled' &&
      outcome !== 'error'
    ) {
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
