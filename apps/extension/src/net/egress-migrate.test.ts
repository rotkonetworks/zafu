import { beforeEach, describe, expect, it } from 'vitest';
import { legacyEnabledNetworks, migrateNetEgress, runNetEgressMigration } from './egress-migrate';
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

  // what storage really holds once a password exists: the wallet list sealed,
  // each multisig's frost vault plaintext
  const SEALED = { encrypted: { nonce: 'bm9uY2U=', cipherText: 'c2VhbGVk' } };
  const FROST_VAULT = {
    id: 'v1',
    type: 'frost-multisig',
    encryptedData: '{}',
    insensitive: { threshold: 2, maxSigners: 3, relayUrl: 'https://frost.example' },
  };

  it('keeps the multisig relay when the wallet list is sealed', () => {
    const next = migrateNetEgress({
      netEgress: V1,
      zcashWallets: SEALED,
      vaults: [{ id: 'm', type: 'mnemonic', insensitive: {} }, FROST_VAULT],
    }) as { optIns: Record<string, string> };
    expect(next.optIns['multisig-relay']).toBe('allowed');
  });

  it('turns on no relay for a sealed list with no multisig vault', () => {
    const next = migrateNetEgress({
      zcashWallets: SEALED,
      vaults: [{ id: 'm', type: 'mnemonic', insensitive: {} }],
    }) as { optIns: Record<string, string> };
    expect(next.optIns).toEqual({});
  });

  it("allows the multisig wallet's own relay after the upgrade, sealed list and all", () => {
    const storage = { netEgress: V1, zcashWallets: SEALED, vaults: [FROST_VAULT] };
    const table = compileEgress({
      ...storage,
      enabledNetworks: ['zcash'],
      netEgress: migrateNetEgress(storage),
    } as unknown as EgressInputs);
    expect(decideEgress('https://frost.example/rendezvous/poll', 'popup', table).allow).toBe(true);
    expect(decideEgress('https://relay.zafu.pro/rendezvous/poll', 'popup', table).allow).toBe(true);
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

describe('legacyEnabledNetworks', () => {
  it('reads a pre-key install the way the wallet already did', () => {
    expect(
      legacyEnabledNetworks({
        vaults: [
          { type: 'mnemonic', insensitive: {} },
          { type: 'zigner-zafu', insensitive: { supportedNetworks: ['zcash', 'noble'] } },
        ],
      }),
    ).toEqual(['penumbra', 'zcash', 'noble']);
  });

  it('leaves a stored list alone, even an empty one', () => {
    expect(
      legacyEnabledNetworks({ enabledNetworks: [], vaults: [{ type: 'mnemonic' }] }),
    ).toBeUndefined();
    expect(
      legacyEnabledNetworks({ enabledNetworks: ['zcash'], vaults: [{ type: 'mnemonic' }] }),
    ).toBeUndefined();
  });

  it('writes nothing for a fresh install', () => {
    expect(legacyEnabledNetworks({})).toBeUndefined();
    expect(legacyEnabledNetworks({ vaults: [] })).toBeUndefined();
  });
});

describe('runNetEgressMigration', () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  it('carries the multisig relay over from storage as it really is, sealed', async () => {
    await chrome.storage.local.set({
      netEgress: V1,
      enabledNetworks: ['zcash'],
      zcashWallets: { encrypted: { nonce: 'bm9uY2U=', cipherText: 'c2VhbGVk' } },
      vaults: [
        { id: 'v1', type: 'frost-multisig', insensitive: { relayUrl: 'https://frost.example' } },
      ],
    });
    await runNetEgressMigration();
    const { netEgress } = await chrome.storage.local.get('netEgress');
    expect(netEgress).toMatchObject({ v: 2, optIns: { 'multisig-relay': 'allowed' } });
  });
});
