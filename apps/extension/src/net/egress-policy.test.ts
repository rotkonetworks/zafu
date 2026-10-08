import { describe, expect, it, test } from 'vitest';
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
      ['wss://relay.zafu.pro/ws', 'opt-in'],
      // private contact discovery is on unless turned off
      ['https://relay.zafu.pro/bucket?appScope=x', 'allow'],
      ['https://relay.zafu.pro/rendezvous/open', 'opt-in'],
      // networks the user did not enable
      ['https://penumbra.rotko.net/penumbra.core.app.v1.QueryService/AppParameters', 'network-off'],
      // the registry is bundled at build time - no destination owns this host any more
      [
        'https://raw.githubusercontent.com/penumbrafi/registry/main/registry/globals.json',
        'unknown',
      ],
      ['https://noble-rpc.polkachu.com/status', 'network-off'],
      // only one browser-reachable preset ships, and it is the primary: this
      // host is simply unowned
      ['https://us.zec.stardust.rest:443/x', 'unknown'],
      // optional services, off until asked
      // nothing asks hosh for a reference tip any more
      ['https://hosh.zec.rocks/api/v0/zec.json', 'unknown'],
      ['https://zcash.me/api/lookup', 'opt-in'],
      // the old relay hosts are no destination of zafu's any more
      ['wss://zrelay.rotko.net/ws', 'unknown'],
      ['https://relay.zafu.pro/login', 'opt-in'],
      ['https://1click.chaindefuser.com/v0/tokens', 'opt-in'],
      ['https://api.skip.build/v2/info/chains', 'opt-in'],
      ['https://sponsor.zafu.pro/v1/injective/granter', 'opt-in'],
      ['https://license.zafu.pro/license', 'opt-in'],
      // the voting config is bundled at build time - no destination owns this host any more
      [
        'https://raw.githubusercontent.com/valargroup/token-holder-voting-config/2785311/prod/x.json',
        'unknown',
      ],
      // the bundled config's own vote + pir servers are still contacted live
      ['https://prod.vote-chain-primary.valargroup.org/shielded-vote/v1/rounds', 'opt-in'],
      ['https://lb-pir-primary.valargroup.org/query', 'opt-in'],
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
    // the old default is then one of the other zcash servers, off until asked -
    // never "the" light client
    const decision = decide(inputs, 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip');
    expect(decision).toMatchObject({ allow: false, destination: 'zcash-servers' });
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
    // the registry is bundled at build time, not a network destination any more
    expect(outcome(on, 'https://raw.githubusercontent.com/penumbrafi/registry/main/x.json')).toBe(
      'unknown',
    );
  });

  it('opens a cosmos chain only while it is enabled, down to the shared-host path', () => {
    const noble = { enabledNetworks: ['noble'] };
    expect(outcome(noble, 'https://rpc.cosmos.directory/noble/status')).toBe('allow');
    expect(outcome(noble, 'https://rpc.cosmos.directory/cosmoshub/status')).toBe('network-off');
    expect(outcome(noble, 'https://noble-api.polkachu.com/cosmos/bank')).toBe('allow');
  });

  it('opens the nodes the user added to a chain pool, with the chain', () => {
    const pool = { cosmoshubRpcEndpoints: ['https://my-hub.example'] } as EgressInputs;
    expect(outcome({ ...pool, enabledNetworks: ['cosmoshub'] }, 'https://my-hub.example/')).toBe(
      'allow',
    );
    expect(outcome({ ...pool, enabledNetworks: ['penumbra'] }, 'https://my-hub.example/')).toBe(
      'network-off',
    );
    expect(outcome({ enabledNetworks: ['cosmoshub'] }, 'https://my-hub.example/')).toBe('unknown');
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

  it('discovery is one destination: on unless turned off, then only its relay', () => {
    const own = { relayEndpoint: 'https://r.example' };
    expect(
      outcome(
        { ...ZCASH_ONLY, zidDiscovery: { ...own, enabled: false } },
        'https://r.example/bucket',
      ),
    ).toBe('opt-in');
    expect(outcome({ ...ZCASH_ONLY, zidDiscovery: own }, 'https://r.example/bucket')).toBe('allow');
    const on = { ...ZCASH_ONLY, zidDiscovery: { ...own, enabled: true } };
    expect(outcome(on, 'https://r.example/bucket')).toBe('allow');
    expect(outcome(on, 'https://r.example/other')).not.toBe('allow');
    const row = describeEgress(on).find(d => d.id === 'contact-discovery');
    expect(row).toMatchObject({ on: true, why: 'setting', hosts: ['r.example/bucket'] });
  });

  it('turn on through an opt-in, and follow per-wallet relays', () => {
    const optIns = { 'chat-relay': 'allowed', 'multisig-relay': 'allowed' } as const;
    const inputs: EgressInputs = {
      ...ZCASH_ONLY,
      netEgress: { optIns },
      zcashWallets: [{ multisig: { relayUrl: 'https://frost.example' } }, {}],
    };
    expect(outcome(inputs, 'wss://relay.zafu.pro/ws')).toBe('allow');
    expect(outcome(inputs, 'https://frost.example/rendezvous/x')).toBe('allow');
    expect(outcome(inputs, 'https://zcash.me/api/lookup')).toBe('opt-in');
  });

  it('a shelved service never turns on by a destination opt-in', () => {
    const inputs: EgressInputs = { ...ZCASH_ONLY, netEgress: { optIns: { license: 'allowed' } } };
    expect(outcome(inputs, 'https://license.zafu.pro/license')).toBe('opt-in');
    expect(describeEgress(inputs).some(d => d.id === 'license')).toBe(false);
  });

  it('ignore an opt-in for a destination since removed (maya)', () => {
    const inputs: EgressInputs = {
      ...ZCASH_ONLY,
      netEgress: { optIns: { mayachain: 'allowed', 'near-swap': 'allowed' } },
    };
    expect(outcome(inputs, 'https://mayanode.mayachain.info/mayachain/inbound_addresses')).toBe(
      'unknown',
    );
    expect(outcome(inputs, 'https://1click.chaindefuser.com/v0/tokens')).toBe('allow');
    expect(describeEgress(inputs).some(d => d.id === 'mayachain')).toBe(false);
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
      destinations: {
        '1click.chaindefuser.com': { state: 'allowed' },
        'x.example': { state: 'allowed' },
      },
    };
    expect(
      outcome({ ...ZCASH_ONLY, netEgress: allowed }, 'https://1click.chaindefuser.com/v0/tokens'),
    ).toBe('allow');
    expect(outcome({ ...ZCASH_ONLY, netEgress: allowed }, 'https://x.example/')).toBe('allow');
    const both = { ...allowed, optIns: { 'near-swap': 'blocked' as const } };
    expect(
      outcome({ ...ZCASH_ONLY, netEgress: both }, 'https://1click.chaindefuser.com/v0/tokens'),
    ).toBe('blocked');
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

  // nym is on, but only the nym worker reaches it, and only when a send needs it
  it('nothing is on with nothing enabled, but private contact discovery and nym', () => {
    expect(outcome({}, 'https://zcash.rotko.net/x')).toBe('network-off');
    expect(
      describeEgress({})
        .filter(d => d.on)
        .map(d => d.id),
    ).toEqual(['custom-networks', 'contact-discovery', 'nym']);
    expect(
      describeEgress({ zidDiscovery: { enabled: false } })
        .filter(d => d.on)
        .map(d => d.id),
    ).toEqual(['custom-networks', 'nym']);
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
    });
    expect(view.find(d => d.id === 'zcash')?.hosts).toEqual(['zcash.rotko.net']);
    expect(view.find(d => d.id === 'chat-relay')?.hosts).toContain('relay.zafu.pro/ws');
  });

  it('lists each host under the destination that owns it, and what is needed', () => {
    const view = describeEgress({ enabledNetworks: ['zcash'] });
    const byId = Object.fromEntries(view.map(d => [d.id, d]));
    // only one preset ships, and it is already owned by the required `zcash`
    // destination, so "other zcash servers" has nothing left to list
    expect(byId['zcash-servers']!.hosts).toEqual([]);
    expect(byId['zcash']).toMatchObject({ needed: true, networks: ['zcash'] });
    expect(byId['penumbra']).toMatchObject({ needed: false, networks: [] });
    expect(view.filter(d => d.needed).map(d => d.id)).toEqual(['zcash']);
  });
});

describe('the removed zcash tip cross-check', () => {
  it('ignores a stored opt-in for it: no row, no host, nothing allowed', () => {
    const inputs: EgressInputs = {
      ...ZCASH_ONLY,
      networkEndpoints: { zcash: 'https://zidecar.example.org' },
      netEgress: { optIns: { 'zcash-tip-check': 'allowed' } },
    };
    expect(describeEgress(inputs).some(d => d.id === 'zcash-tip-check')).toBe(false);
    const decision = decide(inputs, 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip');
    expect(decision).toMatchObject({ allow: false, destination: 'zcash-servers' });
    expect(outcome(inputs, 'https://zidecar.example.org/x')).toBe('allow');
  });
});

describe('wallets sealed at rest', () => {
  it("follows each multisig vault's own relay while the wallets list is sealed", () => {
    const inputs = {
      ...ZCASH_ONLY,
      zcashWallets: { encrypted: { nonce: 'bm9uY2U=', cipherText: 'c2VhbGVk' } },
      vaults: [
        { type: 'mnemonic', insensitive: {} },
        { type: 'frost-multisig', insensitive: { relayUrl: 'https://frost.example' } },
        { type: 'frost-multisig', insensitive: {} },
      ],
    } as unknown as EgressInputs;
    expect(outcome(inputs, 'https://frost.example/rendezvous/x')).toBe('opt-in');
    const on = { ...inputs, netEgress: { optIns: { 'multisig-relay': 'allowed' as const } } };
    expect(outcome(on, 'https://frost.example/rendezvous/x')).toBe('allow');
    expect(describeEgress(on).find(d => d.id === 'multisig-relay')?.hosts).toEqual([
      'relay.zafu.pro',
      'frost.example',
    ]);
  });

  it('still allows the zcash node while the wallets list is sealed at rest', () => {
    const t = compileEgress({
      enabledNetworks: ['zcash'],
      zcashWallets: { encrypted: { c: 'x' } },
    } as unknown as EgressInputs);
    expect(t.rules.find(r => r.destination === 'zcash')).toMatchObject({ allow: true });
  });
});

describe('two optional services on one url', () => {
  // contact discovery and the people relay both default to relay.zafu.pro/bucket
  const url = 'https://relay.zafu.pro/bucket?appScope=zafu-group-v1&epoch=1&shard=ab';
  // discovery is on unless turned off; these cases turn it off to look at the people relay alone
  const discoveryOff = { zidDiscovery: { enabled: false } };
  const decide = (optIns: Record<string, 'allowed' | 'blocked'>) =>
    decideEgress(url, 'service-worker', compileEgress({ ...discoveryOff, netEgress: { optIns } }));

  test('off until one of them is on', () => {
    expect(decide({}).allow).toBe(false);
  });

  test('discovery left alone lets the shared url through', () => {
    expect(decideEgress(url, 'service-worker', compileEgress({}))).toMatchObject({
      allow: true,
      destination: 'contact-discovery',
    });
  });

  test('the people relay on lets the shared url through', () => {
    expect(decide({ 'people-relay': 'allowed' })).toMatchObject({
      allow: true,
      destination: 'people-relay',
    });
  });

  test('both rows list the host in settings', () => {
    const view = describeEgress({});
    for (const id of ['people-relay', 'contact-discovery']) {
      expect(view.find(d => d.id === id)?.hosts).toContain('relay.zafu.pro/bucket');
    }
  });

  test('a people relay the person chose goes through egress, and the one it replaced stays allowed', () => {
    const peopleRelay = {
      endpoint: 'https://relay.example.org',
      hosts: ['https://relay.zafu.pro'],
    };
    const t = compileEgress({
      ...discoveryOff,
      netEgress: { optIns: { 'people-relay': 'allowed' } },
      peopleRelay,
    });
    for (const host of ['https://relay.example.org', 'https://relay.zafu.pro']) {
      expect(decideEgress(`${host}/bucket?shard=ab`, 'service-worker', t)).toMatchObject({
        allow: true,
        destination: 'people-relay',
      });
    }
    // and nothing the person did not choose
    expect(decideEgress('https://relay.other.org/bucket', 'service-worker', t).allow).toBe(false);
    // off until the people relay is allowed, whatever the url
    const off = compileEgress({ peopleRelay });
    expect(decideEgress('https://relay.example.org/bucket', 'service-worker', off).allow).toBe(
      false,
    );
  });

  test('a network endpoint still owns its url alone', () => {
    const i = { enabledNetworks: [] as string[] };
    const zcash = describeEgress(i).find(d => d.id === 'zcash-servers');
    const light = describeEgress(i).find(d => d.id === 'zcash');
    expect(light?.hosts.every(h => !zcash?.hosts.includes(h))).toBe(true);
  });
});

describe('send over nym: the transport is chosen per request class', () => {
  const nymOf = (inputs: EgressInputs, url: string, realm: EgressRealm = 'worker') => {
    const d = decide(inputs, url, realm);
    return d.allow ? (d.nym ?? 'direct') : d.reason;
  };
  const NYM_OFF: EgressInputs = { ...ZCASH_ONLY, netEgress: { optIns: { nym: 'blocked' } } };

  it('sends and looks up your own transactions over nym, and syncs directly', () => {
    const rows: [string, string][] = [
      ['https://zcash.rotko.net/zidecar.v1.Zidecar/SendTransaction', 'broadcast'],
      // a lightwalletd's native grpc needs http/2, which nym's client lacks: direct
      ['https://zcash.rotko.net/cash.z.wallet.sdk.rpc.CompactTxStreamer/SendTransaction', 'direct'],
      ['https://zcash.rotko.net/zidecar.v1.Zidecar/GetTransaction', 'own-tx'],
      ['https://zcash.rotko.net/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction', 'direct'],
      ['https://zcash.rotko.net/zidecar.v1.Zidecar/GetCompactBlocks', 'direct'],
      ['https://zcash.rotko.net/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlockRange', 'direct'],
      ['https://zcash.rotko.net/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo', 'direct'],
      // a sibling method is not the class
      ['https://zcash.rotko.net/zidecar.v1.Zidecar/GetBlockTransactions', 'direct'],
    ];
    for (const [url, expected] of rows) {
      expect([url, nymOf(ZCASH_ONLY, url)]).toEqual([url, expected]);
    }
  });

  it('keeps the FlyClient proof direct: it comes from your own node and names nothing', () => {
    const url = 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetFlyClientProof';
    expect(nymOf(ZCASH_ONLY, url)).toBe('direct');
    // an explicit row, not an accident of no row matching
    const rule = compileEgress(ZCASH_ONLY).rules.find(r => r.path.endsWith('/GetFlyClientProof'));
    expect(rule).toMatchObject({ destination: 'zcash', allow: true, nym: undefined });
  });

  it('is on by default and off when the person turns it off', () => {
    expect(compileEgress(ZCASH_ONLY).nym).toBe(true);
    expect(compileEgress(NYM_OFF).nym).toBe(false);
    expect(nymOf(NYM_OFF, 'https://zcash.rotko.net/zidecar.v1.Zidecar/SendTransaction')).toBe(
      'direct',
    );
  });

  it('follows the configured endpoint and its path', () => {
    const inputs = { ...ZCASH_ONLY, networkEndpoints: { zcash: 'https://node.example/lwd' } };
    expect(nymOf(inputs, 'https://node.example/lwd/zidecar.v1.Zidecar/SendTransaction')).toBe(
      'broadcast',
    );
  });

  it('keeps a node on a port nym cannot exit to direct, rather than unreachable', () => {
    const inputs = { ...ZCASH_ONLY, networkEndpoints: { zcash: 'https://node.example:9067' } };
    expect(nymOf(inputs, 'https://node.example:9067/zidecar.v1.Zidecar/SendTransaction')).toBe(
      'direct',
    );
  });

  it("gives nym's directory and gateways to the nym worker only, and nothing else to it", () => {
    for (const url of ['https://validator.nymtech.net/api/v1/x', 'wss://gw.example.org:9001/']) {
      expect(outcome(ZCASH_ONLY, url, 'nym')).toBe('allow');
      expect(outcome(ZCASH_ONLY, url, 'worker')).toBe('unknown');
      expect(outcome(ZCASH_ONLY, url, 'popup')).toBe('unknown');
    }
    // its hardcoded fallbacks, and every other destination, are refused there
    expect(outcome(ZCASH_ONLY, 'https://nymvpn.com/api/x', 'nym')).toBe('unknown');
    expect(outcome(ZCASH_ONLY, 'wss://gw.example.org:9000/', 'nym')).toBe('unknown');
    expect(outcome(ZCASH_ONLY, 'https://zcash.rotko.net/zidecar.v1.Zidecar/GetTip', 'nym')).toBe(
      'unknown',
    );
    // turned off, the nym worker reaches nothing
    expect(outcome(NYM_OFF, 'https://validator.nymtech.net/api/v1/x', 'nym')).toBe('blocked');
  });
});

describe('send over nym: everything that ties you to a transaction or an address', () => {
  const inputs: EgressInputs = {
    enabledNetworks: ['zcash', 'penumbra', 'noble'],
    netEgress: {
      optIns: {
        thorchain: 'allowed',
        midgard: 'allowed',
        'near-swap': 'allowed',
        'zcash-me': 'allowed',
        peer: 'allowed',
        sponsor: 'allowed',
        voting: 'allowed',
      },
    },
  };
  const table = compileEgress(inputs);
  const nymOf = (url: string) => {
    const d = decideEgress(url, 'popup', table);
    return d.allow ? (d.nym ?? (d.nymBody ? 'body' : 'direct')) : d.reason;
  };

  it('routes what names you over nym, and leaves the public reads direct', () => {
    const thor = 'https://gateway.liquify.com/chain/thorchain_api';
    const rows: [string, string][] = [
      ['https://zcash.rotko.net/zidecar.v1.Zidecar/GetTaddressTxids', 'names-you'],
      ['https://zcash.rotko.net/zidecar.v1.Zidecar/GetAddressUtxos', 'names-you'],
      // penumbra is off by default (see the per-network choice below)
      [
        'https://penumbra.rotko.net/penumbra.util.tendermint_proxy.v1.TendermintProxyService/BroadcastTxSync',
        'direct',
      ],
      ['https://penumbra.rotko.net/penumbra.core.app.v1.QueryService/AppParameters', 'direct'],
      [`${thor}/thorchain/tx/status/ABCD`, 'own-tx'],
      [`${thor}/thorchain/quote/swap?destination=0x1`, 'names-you'],
      [`${thor}/cosmos/auth/v1beta1/accounts/thor1x`, 'names-you'],
      [`${thor}/thorchain/pool/ZEC.ZEC/liquidity_provider/thor1x`, 'names-you'],
      [`${thor}/cosmos/tx/v1beta1/txs`, 'broadcast'],
      [`${thor}/cosmos/tx/v1beta1/txs/ABCD`, 'own-tx'],
      [`${thor}/thorchain/inbound_addresses`, 'direct'],
      [`${thor}/thorchain/mimir`, 'direct'],
      [`${thor}/thorchain/pool/ZEC.ZEC`, 'direct'],
      ['https://thorchain-thornode-lb-1.thorwallet.org/thorchain/tx/status/ABCD', 'own-tx'],
      ['https://gateway.liquify.com/chain/thorchain_midgard/v2/actions?address=x', 'names-you'],
      ['https://gateway.liquify.com/chain/thorchain_midgard/v2/pools', 'direct'],
      ['https://1click.chaindefuser.com/v0/quote', 'names-you'],
      ['https://1click.chaindefuser.com/v0/status?depositAddress=x', 'names-you'],
      ['https://1click.chaindefuser.com/v0/tokens', 'direct'],
      ['https://zcash.me/api/lookup/alice', 'names-you'],
      ['https://sponsor.zafu.pro/base/gas', 'names-you'],
      ['https://prod.vote-chain-primary.valargroup.org/shielded-vote/v1/rounds', 'names-you'],
      ['https://lb-pir-primary.valargroup.org/query', 'direct'],
    ];
    for (const [url, expected] of rows) {
      expect([url, nymOf(url)]).toEqual([url, expected]);
    }
  });

  it('reads a cometbft broadcast off its JSON-RPC body', () => {
    const d = decideEgress('https://noble-rpc.polkachu.com/', 'popup', table);
    expect(
      d.allow &&
        d.nymBody?.map(([p, c]) => [
          new RegExp(p).test('{"jsonrpc":"2.0","method":"broadcast_tx_sync"}'),
          c,
        ]),
    ).toContainEqual([true, 'broadcast']);
    expect(d.allow && d.nymBody?.some(([p]) => new RegExp(p).test('{"method":"status"}'))).toBe(
      false,
    );
  });
});

describe('send over nym: the choice per network', () => {
  const ZEC_SEND = 'https://zcash.rotko.net/zidecar.v1.Zidecar/SendTransaction';
  const PEN_SEND =
    'https://penumbra.rotko.net/penumbra.util.tendermint_proxy.v1.TendermintProxyService/BroadcastTxSync';
  const NOBLE_SEND = 'https://noble-api.polkachu.com/cosmos/tx/v1beta1/txs';
  const THOR_SEND = 'https://gateway.liquify.com/chain/thorchain_api/cosmos/tx/v1beta1/txs';
  const route = (optIns: Record<string, 'allowed' | 'blocked'>, url: string) => {
    const d = decide(
      {
        enabledNetworks: ['zcash', 'penumbra', 'noble'],
        netEgress: { optIns: { thorchain: 'allowed', ...optIns } },
      },
      url,
      'worker',
    );
    return d.allow ? (d.nym ?? 'direct') : d.reason;
  };

  test.each<[string, Record<string, 'allowed' | 'blocked'>, string, string]>([
    ['zcash on by default', {}, ZEC_SEND, 'broadcast'],
    ['cosmos chains on by default', {}, NOBLE_SEND, 'broadcast'],
    ['thorchain on by default', {}, THOR_SEND, 'broadcast'],
    ['penumbra off by default', {}, PEN_SEND, 'direct'],
    ['penumbra turned on', { 'nym:penumbra': 'allowed' }, PEN_SEND, 'broadcast'],
    ['zcash turned off', { 'nym:zcash': 'blocked' }, ZEC_SEND, 'direct'],
    ['zcash off leaves cosmos on', { 'nym:zcash': 'blocked' }, NOBLE_SEND, 'broadcast'],
    ['cosmos turned off', { 'nym:cosmos': 'blocked' }, NOBLE_SEND, 'direct'],
    ['master off: zcash direct', { nym: 'blocked' }, ZEC_SEND, 'direct'],
    ['master off: thorchain direct', { nym: 'blocked' }, THOR_SEND, 'direct'],
    [
      'master off wins over a network turned on',
      { nym: 'blocked', 'nym:penumbra': 'allowed' },
      PEN_SEND,
      'direct',
    ],
  ])('%s', (_, optIns, url, expected) => {
    expect(route(optIns, url)).toBe(expected);
  });

  it('a network turned off does not stop nym itself, the master does', () => {
    const optIns = { 'nym:zcash': 'blocked' as const };
    expect(compileEgress({ ...ZCASH_ONLY, netEgress: { optIns } }).nym).toBe(true);
  });
});
