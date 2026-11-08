import { describe, expect, it } from 'vitest';
import { compileEgress } from './egress-policy';
import { decideEgress } from './egress-table';
import { isProxyConfig, pacFor, proxyAnswer, proxyHosts, proxyInUse } from './proxy';

const HTTP = { kind: 'http' as const, host: 'resi.example', port: 80, on: true };
const LOGIN = { username: 'u', password: 'p' };

/** run a PAC script the way Chrome does: FindProxyForURL(url, host) */
const pac = (script: string) =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(`${script}; return FindProxyForURL;`)() as (url: string, host: string) => string;

describe('the proxy, for zafu only', () => {
  it("sends zafu's hosts through it with no direct fallback, and every other host direct", () => {
    const hosts = proxyHosts(
      compileEgress({
        enabledNetworks: ['zcash'],
        networkEndpoints: { zcash: 'https://node.example:9067' },
      }),
    );
    expect(hosts).toContain('node.example');
    expect(hosts.every(h => !h.includes(':') && !h.startsWith('*'))).toBe(true);
    const find = pac(pacFor(HTTP, hosts));
    expect(find('https://node.example:9067/x', 'node.example')).toBe('PROXY resi.example:80');
    expect(find('https://NODE.example/x', 'NODE.example')).toBe('PROXY resi.example:80');
    expect(find('https://news.example/', 'news.example')).toBe('DIRECT');
    expect(pac(pacFor({ ...HTTP, kind: 'socks5' }, hosts))('', 'node.example')).toBe(
      'SOCKS5 resi.example:80',
    );
    expect(pac(pacFor({ ...HTTP, kind: 'https' }, hosts))('', 'node.example')).toBe(
      'HTTPS resi.example:80',
    );
  });

  it('includes a host the person allowed by hand', () => {
    expect(
      proxyHosts({ rules: [], hosts: { 'x.example': 'allowed', 'y.example': 'blocked' } }),
    ).toEqual(['x.example']);
  });

  it('a host or script in the address never escapes the PAC string', () => {
    expect(isProxyConfig({ ...HTTP, host: 'a"; return "DIRECT' })).toBe(false);
    expect(isProxyConfig({ ...HTTP, port: 70000 })).toBe(false);
    expect(proxyInUse({ ...HTTP, on: false })).toBeUndefined();
    expect(proxyInUse(HTTP)).toEqual(HTTP);
  });

  it('logs in only to this proxy, only while the login can be read, never for a site', () => {
    const asks = (host: string, port: number, isProxy = true) => ({
      isProxy,
      challenger: { host, port },
    });
    expect(proxyAnswer(asks('resi.example', 80), HTTP, LOGIN)).toEqual({ authCredentials: LOGIN });
    expect(proxyAnswer(asks('RESI.example', 80), HTTP, LOGIN)).toEqual({ authCredentials: LOGIN });
    // another proxy, another port, locked, or socks5: refused
    expect(proxyAnswer(asks('evil.example', 80), HTTP, LOGIN)).toEqual({ cancel: true });
    expect(proxyAnswer(asks('resi.example', 81), HTTP, LOGIN)).toEqual({ cancel: true });
    expect(proxyAnswer(asks('resi.example', 80), HTTP, undefined)).toEqual({ cancel: true });
    expect(proxyAnswer(asks('resi.example', 80), { ...HTTP, kind: 'socks5' }, LOGIN)).toEqual({
      cancel: true,
    });
    // asked again for the same request: the login was refused, never sent in a loop
    expect(proxyAnswer(asks('resi.example', 80), HTTP, LOGIN, true)).toEqual({ cancel: true });
    // a site's own login is the browser's, not zafu's
    expect(proxyAnswer(asks('site.example', 443, false), HTTP, LOGIN)).toEqual({});
  });
});

describe('nym and a proxy', () => {
  it('nym carries nothing while the proxy carries zafu', () => {
    const chosen = {
      enabledNetworks: ['zcash'],
      netEgress: { optIns: { nym: 'allowed' as const } },
    };
    expect(compileEgress(chosen).nym).toBe(true);
    expect(compileEgress({ ...chosen, netProxy: HTTP }).nym).toBe(false);
    expect(compileEgress({ ...chosen, netProxy: { ...HTTP, on: false } }).nym).toBe(true);
  });
});

describe('fail closed', () => {
  const base = { enabledNetworks: ['zcash'], netProxy: HTTP };
  const url = 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip';

  it("refuses zafu's traffic while a chosen proxy isn't applied, and passes it once it is", () => {
    for (const applied of [undefined, 'no-permission', 'other-extension']) {
      const d = decideEgress(url, 'popup', compileEgress({ ...base, netProxyApplied: applied }));
      expect(d).toMatchObject({ allow: false, reason: 'transport-down', proxy: true });
    }
    expect(
      decideEgress(url, 'popup', compileEgress({ ...base, netProxyApplied: 'ok' })).allow,
    ).toBe(true);
    // no proxy chosen: nothing to wait for
    expect(decideEgress(url, 'popup', compileEgress({ enabledNetworks: ['zcash'] })).allow).toBe(
      true,
    );
  });

  it("leaves a node on the person's own network out of the PAC, and lets it through", () => {
    const lan = {
      ...base,
      networkEndpoints: { zcash: 'http://192.168.1.5:8232' },
    };
    expect(proxyHosts(compileEgress(lan))).not.toContain('192.168.1.5');
    expect(
      decideEgress(
        'http://192.168.1.5:8232/x',
        'popup',
        compileEgress({ ...lan, netProxyApplied: 'no-permission' }),
      ).allow,
    ).toBe(true);
  });
});
