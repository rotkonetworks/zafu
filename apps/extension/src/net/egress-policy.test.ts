import { describe, expect, it } from 'vitest';
import { compileEgress, describeEgress, type EgressInputs } from './egress-policy';
import { decideEgress, type EgressRealm } from './egress-table';

const decide = (inputs: EgressInputs, url: string, realm: EgressRealm = 'popup') =>
  decideEgress(url, realm, compileEgress(inputs));

const outcome = (inputs: EgressInputs, url: string, realm?: EgressRealm) => {
  const d = decide(inputs, url, realm);
  return d.allow ? 'allow' : d.reason;
};

const ZCASH_ONLY: EgressInputs = { enabledNetworks: ['zcash'] };

describe('a fresh zcash-only wallet', () => {
  it('reaches its light client and nothing else', () => {
    const rows: [string, string][] = [
      ['https://zcash.rotko.net/zidecar.v1.Zidecar/GetCompactBlocks', 'allow'],
      ['https://zcash.rotko.net/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo', 'allow'],
      // other services on the same host are their own, optional destinations
      ['wss://zcash.rotko.net/ws', 'opt-in'],
      ['https://zcash.rotko.net/bucket?appScope=x', 'opt-in'],
      ['https://zcash.rotko.net/rendezvous/open', 'opt-in'],
      // networks the user did not enable
      ['https://penumbra.rotko.net/penumbra.core.app.v1.QueryService/AppParameters', 'network-off'],
      [
        'https://raw.githubusercontent.com/penumbrafi/registry/main/registry/globals.json',
        'network-off',
      ],
      ['https://noble-rpc.polkachu.com/status', 'network-off'],
      ['https://paritytech.github.io/chainspecs/polkadot.json', 'network-off'],
      // the independent cross-check peer: part of the zcash allowance, not optional
      ['https://us.zec.stardust.rest:443/x', 'allow'],
      // optional services, off until asked
      ['https://hosh.zec.rocks/api/v0/zec.json', 'opt-in'],
      ['https://zcash.me/api/lookup', 'opt-in'],
      ['wss://zrelay.rotko.net/ws', 'opt-in'],
      ['https://relay.zafu.pro/login', 'opt-in'],
      ['https://1click.chaindefuser.com/v0/tokens', 'opt-in'],
      ['https://api.skip.build/v2/info/chains', 'opt-in'],
      ['https://sponsor.zafu.pro/v1/injective/granter', 'opt-in'],
      ['https://license.zafu.pro/license', 'opt-in'],
      [
        'https://raw.githubusercontent.com/valargroup/token-holder-voting-config/2785311/prod/x.json',
        'opt-in',
      ],
      // hosts no destination owns
      ['https://api.coingecko.com/api/v3/simple/price', 'unknown'],
      ['https://fonts.googleapis.com/css2', 'unknown'],
      ['https://raw.githubusercontent.com/someone/else/main/x.json', 'unknown'],
    ];
    for (const [url, expected] of rows) {
      expect([url, outcome(ZCASH_ONLY, url)]).toEqual([url, expected]);
    }
  });

  it('is decided the same in every realm but a content script', () => {
    const url = 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip';
    for (const realm of ['service-worker', 'popup', 'page', 'offscreen', 'worker'] as const) {
      expect(outcome(ZCASH_ONLY, url, realm)).toBe('allow');
    }
    expect(outcome(ZCASH_ONLY, url, 'content-script')).toBe('content-script');
  });
});

describe('the required endpoint follows settings', () => {
  it('moves with the configured zcash endpoint', () => {
    const inputs = { ...ZCASH_ONLY, networkEndpoints: { zcash: 'https://eu.zec.rocks:443' } };
    expect(outcome(inputs, 'https://eu.zec.rocks/x')).toBe('allow');
    // the old default is now reached only as the independent tip-check peer,
    // never as "the" light client
    const decision = decide(inputs, 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip');
    expect(decision).toMatchObject({ allow: true, destination: 'zcash-tip-check' });
  });

  it('a non-default port is its own destination', () => {
    const inputs = { ...ZCASH_ONLY, networkEndpoints: { zcash: 'https://node.example:9067' } };
    expect(outcome(inputs, 'https://node.example:9067/x')).toBe('allow');
    expect(outcome(inputs, 'https://node.example/x')).toBe('unknown');
  });

  it('resolves penumbra like the wallet does: picked node, then the legacy key, then the default', () => {
    const on = { enabledNetworks: ['penumbra'] };
    expect(outcome(on, 'https://penumbra.rotko.net/x')).toBe('allow');
    expect(
      outcome({ ...on, grpcEndpoint: 'https://legacy.example' }, 'https://legacy.example/x'),
    ).toBe('allow');
    const picked = {
      ...on,
      grpcEndpoint: 'https://legacy.example',
      networkEndpoints: { penumbra: 'https://picked.example' },
    };
    expect(outcome(picked, 'https://picked.example/x')).toBe('allow');
    expect(outcome(picked, 'https://legacy.example/x')).toBe('unknown');
    expect(outcome(on, 'https://raw.githubusercontent.com/penumbrafi/registry/main/x.json')).toBe(
      'allow',
    );
  });

  it('opens a cosmos chain only while it is enabled, down to the shared-host path', () => {
    const noble = { enabledNetworks: ['noble'] };
    expect(outcome(noble, 'https://rpc.cosmos.directory/noble/status')).toBe('allow');
    expect(outcome(noble, 'https://rpc.cosmos.directory/cosmoshub/status')).toBe('network-off');
    expect(outcome(noble, 'https://noble-api.polkachu.com/cosmos/bank')).toBe('allow');
  });
});

describe('optional services', () => {
  it('turn on through their own setting', () => {
    expect(
      outcome({ ...ZCASH_ONLY, zcashMeConfig: { mode: 'live' } }, 'https://zcash.me/api/lookup'),
    ).toBe('allow');
    expect(
      outcome(
        {
          ...ZCASH_ONLY,
          zcashMeConfig: { mode: 'directory', mirrorUrl: 'https://mirror.example/dir' },
        },
        'https://mirror.example/dir/all.json',
      ),
    ).toBe('allow');
    expect(
      outcome({ ...ZCASH_ONLY, zidDiscovery: { enabled: true } }, 'https://zcash.rotko.net/bucket'),
    ).toBe('allow');
    const ownRelay = {
      ...ZCASH_ONLY,
      zidDiscovery: { enabled: true, relayEndpoint: 'https://r.example/' },
    };
    expect(outcome(ownRelay, 'https://r.example/bucket?x=1')).toBe('allow');
  });

  it('turn on through an opt-in, and follow per-wallet relays', () => {
    const optIns = { 'chat-relay': 'allowed', 'multisig-relay': 'allowed' } as const;
    const inputs: EgressInputs = {
      ...ZCASH_ONLY,
      netEgress: { optIns },
      zcashWallets: [{ multisig: { relayUrl: 'https://frost.example' } }, {}],
    };
    expect(outcome(inputs, 'wss://zrelay.rotko.net/ws')).toBe('allow');
    expect(outcome(inputs, 'wss://zcash.rotko.net/ws/zid')).toBe('allow');
    expect(outcome(inputs, 'https://frost.example/rendezvous/x')).toBe('allow');
    expect(outcome(inputs, 'https://zcash.me/api/lookup')).toBe('opt-in');
  });

  it('a shelved service never turns on by a destination opt-in', () => {
    const inputs: EgressInputs = { ...ZCASH_ONLY, netEgress: { optIns: { license: 'allowed' } } };
    expect(outcome(inputs, 'https://license.zafu.pro/license')).toBe('opt-in');
    expect(describeEgress(inputs).some(d => d.id === 'license')).toBe(false);
  });
});

describe('the user always has the last word', () => {
  it('blocking a destination refuses it even when a network needs it', () => {
    const inputs: EgressInputs = { ...ZCASH_ONLY, netEgress: { optIns: { zcash: 'blocked' } } };
    expect(outcome(inputs, 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip')).toBe('blocked');
  });

  it('blocking a host refuses every destination on it', () => {
    const inputs: EgressInputs = {
      ...ZCASH_ONLY,
      zidDiscovery: { enabled: true },
      netEgress: { destinations: { 'zcash.rotko.net': { state: 'blocked' } } },
    };
    expect(outcome(inputs, 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip')).toBe('blocked');
    expect(outcome(inputs, 'https://zcash.rotko.net/bucket')).toBe('blocked');
  });

  it('allowing a host opens it, unless its destination is blocked', () => {
    const allowed = {
      destinations: { 'hosh.zec.rocks': { state: 'allowed' }, 'x.example': { state: 'allowed' } },
    };
    expect(outcome({ ...ZCASH_ONLY, netEgress: allowed }, 'https://hosh.zec.rocks/api')).toBe(
      'allow',
    );
    expect(outcome({ ...ZCASH_ONLY, netEgress: allowed }, 'https://x.example/')).toBe('allow');
    const both = { ...allowed, optIns: { 'zcash-servers': 'blocked' as const } };
    expect(outcome({ ...ZCASH_ONLY, netEgress: both }, 'https://hosh.zec.rocks/api')).toBe(
      'blocked',
    );
  });

  it('a pending record is not a decision', () => {
    const inputs = {
      ...ZCASH_ONLY,
      netEgress: { destinations: { 'x.example': { state: 'pending' } } },
    };
    expect(outcome(inputs, 'https://x.example/')).toBe('unknown');
  });
});

describe('edges', () => {
  it('fails closed before the table arrives', () => {
    expect(decideEgress('https://zcash.rotko.net/', 'worker', undefined)).toMatchObject({
      allow: false,
      reason: 'not-ready',
    });
  });

  it('never gates what does not leave the machine', () => {
    for (const url of [
      'data:text/plain,x',
      'blob:chrome-extension://a/b',
      'chrome-extension://abc/keys/x.bin',
    ]) {
      expect(decideEgress(url, 'worker', undefined).allow).toBe(true);
    }
    expect(outcome({}, 'http://127.0.0.1:5000/apdu')).toBe('allow');
    expect(outcome({}, 'http://localhost:8787/zafu/ota/v1/stream')).toBe('allow');
  });

  it('nothing is on with nothing enabled', () => {
    expect(outcome({}, 'https://zcash.rotko.net/x')).toBe('network-off');
    expect(
      describeEgress({})
        .filter(d => d.on)
        .map(d => d.id),
    ).toEqual(['custom-networks']);
  });

  it('names the destination on a refusal, so the ui can offer to allow it', () => {
    expect(decide(ZCASH_ONLY, 'https://zcash.me/api/lookup')).toEqual({
      allow: false,
      host: 'zcash.me',
      destination: 'zcash-me',
      reason: 'opt-in',
    });
  });
});

describe('describeEgress', () => {
  it('says why each destination is on or off', () => {
    const view = describeEgress({
      enabledNetworks: ['zcash'],
      zcashMeConfig: { mode: 'live' },
      netEgress: { optIns: { 'chat-relay': 'allowed', 'near-swap': 'blocked' } },
    });
    const why = Object.fromEntries(view.map(d => [d.id, d.why]));
    expect(why).toMatchObject({
      zcash: 'network',
      penumbra: 'network-off',
      'zcash-me': 'setting',
      'chat-relay': 'you-allowed',
      'near-swap': 'you-blocked',
      'zcash-servers': 'default-off',
      'custom-networks': 'configured',
      'zcash-tip-check': 'network',
    });
    expect(view.find(d => d.id === 'zcash')?.hosts).toEqual(['zcash.rotko.net']);
    expect(view.find(d => d.id === 'chat-relay')?.hosts).toContain('zcash.rotko.net/ws');
  });

  it('lists each host under the destination that owns it, and what is needed', () => {
    const view = describeEgress({ enabledNetworks: ['zcash'] });
    const byId = Object.fromEntries(view.map(d => [d.id, d]));
    expect(byId['zcash-servers']!.hosts).not.toContain('zcash.rotko.net');
    expect(byId['zcash-servers']!.hosts).toContain('zec.rocks');
    // the cross-check peer is owned by the tip-check destination, not "other servers"
    expect(byId['zcash-servers']!.hosts).not.toContain('us.zec.stardust.rest');
    expect(byId['zcash-tip-check']!.hosts).toEqual(['us.zec.stardust.rest']);
    expect(byId['zcash']).toMatchObject({ needed: true, networks: ['zcash'] });
    expect(byId['zcash-tip-check']).toMatchObject({ needed: true, networks: ['zcash'] });
    expect(byId['penumbra']).toMatchObject({ needed: false, networks: [] });
    expect(view.filter(d => d.needed).map(d => d.id)).toEqual(['zcash', 'zcash-tip-check']);
  });
});

describe('the zcash tip cross-check', () => {
  it('is allowed by default alongside the light client, pointed at one independent preset', () => {
    const view = describeEgress(ZCASH_ONLY);
    const check = view.find(d => d.id === 'zcash-tip-check');
    expect(check).toMatchObject({ on: true, why: 'network', needed: true });
    expect(check?.hosts).toEqual(['us.zec.stardust.rest']);
  });

  it('moves with the configured zcash endpoint, same helper the worker calls', () => {
    const inputs = { ...ZCASH_ONLY, networkEndpoints: { zcash: 'https://eu.zec.rocks:443' } };
    // the configured endpoint is no longer the primary's own domain, so the
    // default rotko preset becomes the independent peer
    expect(outcome(inputs, 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip')).toBe('allow');
  });
});
