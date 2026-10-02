/**
 * The egress decision, over a compiled table.
 *
 * The table is plain data (see `./egress-policy` for how it is compiled from
 * settings), so it can be sent to realms without storage - the offscreen
 * document and web workers - and decided there synchronously. This file must
 * stay free of config and storage imports for the same reason: it is bundled
 * into every worker.
 */

import { hostOf, isLocalDeviceHost } from './destination';

/** Where the request is being made from. */
export type EgressRealm =
  | 'service-worker'
  | 'popup'
  | 'page'
  | 'offscreen'
  | 'worker'
  | 'content-script';

/**
 * Why a request was refused. Each maps to one calm sentence in the UI:
 *  - `blocked`: the user blocked this host or destination
 *  - `network-off`: it serves a network that is not enabled
 *  - `opt-in`: an optional service the user has not turned on
 *  - `unknown`: not a destination zafu knows or the user added
 *  - `content-script`: a web page's context never talks to anyone
 *  - `not-ready`: this realm has no policy yet (fails closed)
 */
export type EgressReason =
  | 'blocked'
  | 'network-off'
  | 'opt-in'
  | 'unknown'
  | 'content-script'
  | 'not-ready';

/** One (host, path prefix) a destination owns, with its compiled answer. */
export interface EgressRule {
  /** `hostOf` key: hostname, plus port when non-default */
  host: string;
  /** path prefix; '' owns the whole host. The longest matching prefix wins. */
  path: string;
  destination: string;
  allow: boolean;
  reason?: Exclude<EgressReason, 'content-script' | 'not-ready' | 'unknown'>;
  /**
   * An optional service's rule. Two optional services can use one url (the
   * bucket relay serves both contact discovery and people messages): a
   * request cannot say which feature made it, so the url passes when either
   * is on, and each feature gates itself on its own destination.
   */
  shared?: boolean;
}

export interface EgressTable {
  rules: EgressRule[];
  /** per-host user decisions; `blocked` beats every rule, `allowed` beats a default-off */
  hosts: Record<string, 'allowed' | 'blocked'>;
  /** the Keplr-compatible site surface is on, so the worker may ask about unknown hosts */
  adhoc: boolean;
}

export type EgressDecision =
  | { allow: true; host?: string; destination?: string }
  | { allow: false; host: string; destination?: string; reason: EgressReason };

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
};

/**
 * Every rule tied for `url`: same host, longest path prefix, in table order.
 * The first owns it; the rest share it only when all of them are `shared`.
 */
export const matchRules = (table: EgressTable, url: string): EgressRule[] => {
  const host = hostOf(url);
  if (!host) {
    return [];
  }
  const path = pathOf(url);
  let best: EgressRule[] = [];
  for (const rule of table.rules) {
    if (rule.host === host && path.startsWith(rule.path)) {
      const len = best[0]?.path.length ?? -1;
      if (rule.path.length > len) {
        best = [rule];
      } else if (rule.path.length === len) {
        best.push(rule);
      }
    }
  }
  return best.every(r => r.shared) ? best : best.slice(0, 1);
};

/** The rule that owns `url`: same host, longest path prefix, first in table order on a tie. */
export const matchRule = (table: EgressTable, url: string): EgressRule | undefined =>
  matchRules(table, url)[0];

/**
 * Precedence:
 *  1. non-network urls (data:, blob:, chrome-extension:) are not egress;
 *  2. a content script never talks to anyone;
 *  3. no table yet: refuse (fail closed);
 *  4. a device on this computer always passes (ledger bridge, a local node);
 *  5. a host the user blocked is refused, whatever it is for;
 *  6. a destination the user blocked is refused;
 *  7. a host the user allowed passes;
 *  8. otherwise the destination's compiled answer (network on, opted in);
 *  9. a host no destination owns is refused as unknown.
 */
export const decideEgress = (
  url: string,
  realm: EgressRealm,
  table: EgressTable | undefined,
): EgressDecision => {
  const host = hostOf(url);
  if (!host) {
    return { allow: true };
  }
  if (realm === 'content-script') {
    return { allow: false, host, reason: 'content-script' };
  }
  if (!table) {
    return { allow: false, host, reason: 'not-ready' };
  }
  if (isLocalDeviceHost(host)) {
    return { allow: true, host };
  }
  const ties = matchRules(table, url);
  // shared optional rules: the url passes when any of them is on
  const rule = ties.find(r => r.allow) ?? ties[0];
  const destination = rule?.destination;
  const override = table.hosts[host];
  if (override === 'blocked' || rule?.reason === 'blocked') {
    return { allow: false, host, destination, reason: 'blocked' };
  }
  if (override === 'allowed' || rule?.allow) {
    return { allow: true, host, destination };
  }
  return { allow: false, host, destination, reason: rule?.reason ?? 'unknown' };
};
