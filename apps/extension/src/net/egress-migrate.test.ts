import { describe, expect, it } from 'vitest';
import { migrateNetEgress } from './egress-migrate';
import { compileEgress, type EgressInputs } from './egress-policy';
import { decideEgress } from './egress-table';

const V1 = {
  destinations: {
    // auto-allowed because zafu shipped it
    'noble-rpc.polkachu.com': {
      state: 'allowed',
      trusted: true,
      calls: 12,
      purposes: ['chain-rpc'],
    },
    'relay.zafu.pro': { state: 'allowed', trusted: true, calls: 0 },
    // the user said yes to the consent prompt
    'rpc.dapp.example': { state: 'allowed', trusted: false, calls: 3 },
    // the user said no
    'sponsor.zafu.pro': { state: 'blocked', trusted: true, calls: 1 },
  },
  identities: {},
};

describe('migrateNetEgress', () => {
  it('keeps what the user chose and drops what was only on by default', () => {
    const next = migrateNetEgress({ netEgress: V1 }) as {
      v: number;
      destinations: Record<string, { state: string }>;
      optIns: Record<string, string>;
    };
    expect(next.v).toBe(2);
    expect(next.destinations['noble-rpc.polkachu.com']!.state).toBe('pending');
    expect(next.destinations['relay.zafu.pro']!.state).toBe('pending');
    expect(next.destinations['rpc.dapp.example']!.state).toBe('allowed');
    expect(next.destinations['sponsor.zafu.pro']!.state).toBe('blocked');
    // the worker had really talked to noble: keep the chain reachable
    expect(next.optIns).toEqual({ noble: 'allowed' });
  });

  it('keeps the relays of features the user actually uses', () => {
    const next = migrateNetEgress({
      zcashWallets: [{ id: 'a' }, { id: 'b', multisig: { threshold: 2 } }],
      'zidNick:abc': 'tommi',
    }) as { optIns: Record<string, string> };
    expect(next.optIns).toEqual({ 'multisig-relay': 'allowed', 'chat-relay': 'allowed' });
  });

  it('turns on nothing for a fresh install', () => {
    expect(migrateNetEgress({})).toEqual({ v: 2, destinations: {}, optIns: {} });
  });

  it('runs once', () => {
    expect(migrateNetEgress({ netEgress: { v: 2, destinations: {}, optIns: {} } })).toBeUndefined();
  });

  it('leaves an existing penumbra user on penumbra, and off the services nobody chose', () => {
    const inputs = {
      enabledNetworks: ['penumbra', 'zcash'],
      netEgress: migrateNetEgress({ netEgress: V1 }),
    };
    const allow = (url: string) =>
      decideEgress(url, 'service-worker', compileEgress(inputs as EgressInputs)).allow;
    expect(allow('https://penumbra.rotko.net/x')).toBe(true);
    expect(allow('https://zcash.rotko.net/x')).toBe(true);
    expect(allow('https://noble-rpc.polkachu.com/status')).toBe(true);
    expect(allow('https://rpc.dapp.example/')).toBe(true);
    expect(allow('https://relay.zafu.pro/')).toBe(false);
    expect(allow('https://sponsor.zafu.pro/')).toBe(false);
    expect(allow('https://1click.chaindefuser.com/v0/tokens')).toBe(false);
  });

  it('a v1 ledger read before the migration ran does not allow what zafu auto-allowed', () => {
    const table = compileEgress({ enabledNetworks: ['zcash'], netEgress: V1 } as EgressInputs);
    expect(decideEgress('https://relay.zafu.pro/', 'popup', table).allow).toBe(false);
    expect(decideEgress('https://rpc.dapp.example/', 'popup', table).allow).toBe(true);
  });
});
