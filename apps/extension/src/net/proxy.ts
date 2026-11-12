/**
 * The person's own proxy, for zafu's traffic only (gh #81). A PAC script
 * generated from the egress table sends zafu's own hosts through it and
 * everything else in the browser direct. Fail closed: zafu's hosts have no
 * DIRECT fallback, so a proxy that is down sends nothing rather than
 * showing where the person is.
 *
 * Chrome logs in to an HTTP or HTTPS proxy (answered here, from the sealed
 * login, only for this proxy and only while unlocked) but never to SOCKS5,
 * so SOCKS5 is for a proxy with no login: local Tor, or a local forwarder.
 *
 * The address (`netProxy`) is kept plain so the PAC holds while zafu is
 * locked; the login (`netProxyLogin`) is sealed. Pure parts here; the
 * service worker applies them (./proxy-apply).
 */

import type { EgressTable } from './egress-table';
import { isPrivateNetworkHost } from './destination';

export type ProxyKind = 'http' | 'https' | 'socks5';

export interface ProxyConfig {
  kind: ProxyKind;
  host: string;
  port: number;
  /** zafu's traffic goes through it */
  on: boolean;
}

export interface ProxyLogin {
  username: string;
  password: string;
}

export const PROXY_KEY = 'netProxy';
export const PROXY_LOGIN_KEY = 'netProxyLogin';
/** what the service worker found applying the proxy: 'ok', or why not */
export const PROXY_APPLIED_KEY = 'netProxyApplied';
export type ProxyApplied = 'ok' | 'no-permission' | 'other-extension';

const HOST = /^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/i;

/** a stored value is a proxy only if it has the shape this build writes */
export const isProxyConfig = (v: unknown): v is ProxyConfig => {
  const p = v as ProxyConfig;
  return (
    !!p &&
    typeof p === 'object' &&
    (p.kind === 'http' || p.kind === 'https' || p.kind === 'socks5') &&
    typeof p.host === 'string' &&
    HOST.test(p.host) &&
    Number.isInteger(p.port) &&
    p.port > 0 &&
    p.port < 65536 &&
    typeof p.on === 'boolean'
  );
};

export const isProxyLogin = (v: unknown): v is ProxyLogin => {
  const l = v as ProxyLogin;
  return !!l && typeof l.username === 'string' && typeof l.password === 'string';
};

/** the proxy in use, or undefined: on, and a shape this build trusts */
export const proxyInUse = (v: unknown): ProxyConfig | undefined =>
  isProxyConfig(v) && v.on ? v : undefined;

/** a rule's host key without its port: a PAC script is handed the bare hostname */
const bare = (h: string): string => h.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');

/** the hosts zafu may contact: every rule's, and every host the person allowed by hand */
export const proxyHosts = (table: Pick<EgressTable, 'rules' | 'hosts'>): string[] =>
  [
    ...new Set(
      [
        ...table.rules.map(r => r.host),
        ...Object.entries(table.hosts)
          .filter(([, d]) => d === 'allowed')
          .map(([h]) => h),
      ]
        // a wildcard (nym's gateways) isn't a host a PAC can name; nym is off with a proxy
        .filter(h => !!h && !h.startsWith('*'))
        .map(h => bare(h).toLowerCase())
        // a node on the person's own network: a proxy out there can't reach it
        .filter(h => !isPrivateNetworkHost(h)),
    ),
  ].sort();

const PAC_KIND: Record<ProxyKind, string> = { http: 'PROXY', https: 'HTTPS', socks5: 'SOCKS5' };

/**
 * The PAC script: zafu's hosts through the proxy and nothing else, with no
 * DIRECT after it (fail closed). SOCKS5 names are resolved by the proxy, so
 * no DNS leaves the machine for them either.
 */
export const pacFor = (p: ProxyConfig, hosts: readonly string[]): string => {
  const via = `${PAC_KIND[p.kind]} ${p.host}:${p.port}`;
  return [
    `var zafu = ${JSON.stringify(Object.fromEntries(hosts.map(h => [h, 1])))};`,
    'function FindProxyForURL(url, host) {',
    `  return zafu[host.toLowerCase()] ? ${JSON.stringify(via)} : "DIRECT";`,
    '}',
  ].join('\n');
};

/** what Chrome is told when a server asks for a login */
export type AuthAnswer =
  | { authCredentials: { username: string; password: string } }
  | { cancel: true }
  | Record<string, never>;

/**
 * A login is given only to this proxy (host and port as configured), only
 * an HTTP(S) one, only while the sealed login can be read, and once per
 * request: a refused login is never sent again in a loop at the proxy. Any
 * other proxy asking is refused; a site's own login is left to the browser.
 */
export const proxyAnswer = (
  details: { isProxy: boolean; challenger: { host: string; port: number } },
  p: ProxyConfig | undefined,
  login: ProxyLogin | undefined,
  /** this request was answered once already: the login was refused, so stop */
  again = false,
): AuthAnswer => {
  if (!details.isProxy) {
    return {};
  }
  if (again) {
    return { cancel: true };
  }
  const ours =
    !!p &&
    p.kind !== 'socks5' &&
    details.challenger.host.toLowerCase() === p.host.toLowerCase() &&
    details.challenger.port === p.port;
  return ours && login ? { authCredentials: { ...login } } : { cancel: true };
};
