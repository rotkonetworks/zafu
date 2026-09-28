import { describe, expect, it } from 'vitest';
import {
  EMPTY_NET_EGRESS,
  NET_EGRESS_LOG_LIMIT,
  hostOf,
  hostnameOf,
  isLocalDeviceHost,
  parseNetEgressLog,
  parseNetEgressState,
} from './destination';

describe('hostOf', () => {
  it('keys by hostname, dropping the default port', () => {
    expect(hostOf('https://zcash.rotko.net/')).toBe('zcash.rotko.net');
    expect(hostOf('https://zcash.rotko.net:443/x')).toBe('zcash.rotko.net');
    expect(hostOf('http://example.com:80')).toBe('example.com');
  });

  it('keeps a non-default port, because it is a different destination', () => {
    expect(hostOf('https://127.0.0.1:8080/')).toBe('127.0.0.1:8080');
    expect(hostOf('http://node.example:9067/x')).toBe('node.example:9067');
  });

  it('normalises case and IPv6 brackets', () => {
    expect(hostOf('https://ZCash.Rotko.NET/')).toBe('zcash.rotko.net');
    expect(hostOf('http://[::1]:8080/')).toBe('::1:8080');
  });

  it('covers ws/wss, which zafu also opens', () => {
    expect(hostOf('wss://relay.example/socket')).toBe('relay.example');
    expect(hostOf('ws://relay.example:8081/socket')).toBe('relay.example:8081');
  });

  it('returns undefined for non-network inputs (nothing to consent to)', () => {
    expect(hostOf('data:text/plain,hi')).toBeUndefined();
    expect(hostOf('blob:https://x/abc')).toBeUndefined();
    expect(hostOf('chrome-extension://abcdef/page.html')).toBeUndefined();
    expect(hostOf('not a url')).toBeUndefined();
    expect(hostOf('/relative/path')).toBeUndefined();
  });

  it('reads the url off a Request without consuming it', () => {
    const req = new Request('https://node.example:9067/GetLightdInfo');
    expect(hostOf(req)).toBe('node.example:9067');
    expect(req.bodyUsed).toBe(false);
  });
});

describe('isLocalDeviceHost', () => {
  it('recognises every spelling of this machine', () => {
    for (const host of [
      'localhost',
      'localhost:8080',
      '127.0.0.1',
      '127.0.0.1:9067',
      '::1',
      '0.0.0.0:5000',
    ]) {
      expect(isLocalDeviceHost(host)).toBe(true);
    }
  });

  it('does not leak the exemption to lookalikes', () => {
    // A hostname whose *label* contains "localhost" is not this machine, and a
    // suffix like .localhost is a DNS name someone else can own.
    for (const host of [
      'notlocalhost.example',
      'localhost.evil.example',
      '127.0.0.2',
      '10.0.0.1',
    ]) {
      expect(isLocalDeviceHost(host)).toBe(false);
    }
  });
});

describe('hostnameOf', () => {
  it('strips the port', () => {
    expect(hostnameOf('node.example:9067')).toBe('node.example');
    expect(hostnameOf('node.example')).toBe('node.example');
  });
});

describe('parseNetEgressState', () => {
  it('returns the empty ledger for junk', () => {
    for (const junk of [null, undefined, 42, 'x', [], {}]) {
      const parsed = parseNetEgressState(junk);
      expect(parsed.destinations).toEqual({});
      expect(parsed.identities).toEqual({});
    }
    expect(parseNetEgressState(null)).toEqual(EMPTY_NET_EGRESS);
  });

  it('drops a destination whose state is unreadable instead of promoting it', () => {
    const parsed = parseNetEgressState({
      destinations: {
        'good.example': { state: 'allowed', trusted: true, purposes: ['chain-rpc'] },
        'bad.example': { state: 'lets-go', trusted: true },
        'worse.example': 'allowed',
      },
    });
    expect(Object.keys(parsed.destinations)).toEqual(['good.example']);
    expect(parsed.destinations['good.example']!.state).toBe('allowed');
    expect(parsed.destinations['good.example']!.trusted).toBe(true);
  });

  it('keeps a malformed entry out of the allowed set even when trusted is set', () => {
    const parsed = parseNetEgressState({
      destinations: { 'x.example': { trusted: true, purposes: ['chain-rpc'], state: 12 } },
    });
    expect(parsed.destinations['x.example']).toBeUndefined();
  });

  it('round-trips a full record', () => {
    const parsed = parseNetEgressState({
      destinations: {
        'zcash.rotko.net': {
          state: 'allowed',
          trusted: true,
          label: 'ships with zafu',
          purposes: ['chain-rpc', 'indexer'],
          firstSeen: 1,
          lastUsed: 2,
          calls: 3,
          identity: 'id-1',
          lastOutcome: 'allowed',
        },
      },
      identities: {
        'id-1': {
          id: 'id-1',
          name: 'tor',
          proxy: { scheme: 'socks5', host: '127.0.0.1', port: 9050 },
          headers: { 'x-api-key': 'k' },
        },
      },
    });
    expect(parsed.destinations['zcash.rotko.net']).toEqual({
      state: 'allowed',
      trusted: true,
      label: 'ships with zafu',
      purposes: ['chain-rpc', 'indexer'],
      firstSeen: 1,
      lastUsed: 2,
      calls: 3,
      identity: 'id-1',
      lastOutcome: 'allowed',
    });
    expect(parsed.identities['id-1']?.proxy).toEqual({
      scheme: 'socks5',
      host: '127.0.0.1',
      port: 9050,
      username: undefined,
      password: undefined,
    });
    expect(parsed.identities['id-1']?.headers).toEqual({ 'x-api-key': 'k' });
  });

  it('drops a proxy with an unknown scheme rather than trusting it', () => {
    const parsed = parseNetEgressState({
      identities: { a: { id: 'a', name: 'x', proxy: { scheme: 'gopher', host: 'h', port: 1 } } },
    });
    expect(parsed.identities['a']?.proxy).toBeUndefined();
  });
});

describe('parseNetEgressLog', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const entries = parseNetEgressLog([
      { ts: 1, host: 'a.example', purpose: 'chain-rpc', outcome: 'allowed' },
      { ts: 2, host: 'b.example', purpose: 'relay', outcome: 'bogus' },
      { host: 'c.example', outcome: 'allowed' },
      'nope',
      { ts: 3, host: 'd.example', purpose: 'other', outcome: 'consent-required', detail: 'x' },
    ]);
    expect(entries.map(e => e.host)).toEqual(['a.example', 'd.example']);
  });

  it('returns an empty trail for junk', () => {
    expect(parseNetEgressLog(null)).toEqual([]);
    expect(parseNetEgressLog({})).toEqual([]);
  });

  it('has a bound small enough to render', () => {
    expect(NET_EGRESS_LOG_LIMIT).toBeGreaterThan(0);
    expect(NET_EGRESS_LOG_LIMIT).toBeLessThanOrEqual(500);
  });
});
