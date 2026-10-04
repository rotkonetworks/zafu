import { describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  compareVersions,
  refreshForUnknownChains,
  verifyRegistry,
  type RegistrySig,
} from './registry-live';

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const secret = ed25519.utils.randomPrivateKey();
const KEY = b64(ed25519.getPublicKey(secret));
const OTHER = b64(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));

const registry = JSON.stringify({
  chainId: 'penumbra-1',
  ibcConnections: [{ chainId: 'stargaze-1', channelId: 'channel-30', newField: 'later' }],
  someFutureKey: { anything: true },
});

const signed = (text: string, version: string, extra: object = {}): RegistrySig => {
  const digest = bytesToHex(sha256(new TextEncoder().encode(text)));
  const fields = {
    format: 'penumbrafi-registry-sig/1',
    chainId: 'penumbra-1',
    version,
    sha256: digest,
  };
  const message = new TextEncoder().encode(
    `${fields.format}\n${fields.chainId}\n${fields.version}\n${fields.sha256}\n`,
  );
  return { ...fields, signature: b64(ed25519.sign(message, secret)), ...extra };
};

describe('verifyRegistry', () => {
  it('accepts a newer copy signed by the key, unknown fields and all', () => {
    const conns = verifyRegistry(
      registry,
      signed(registry, '13.4.0', { note: 'x' }),
      '13.3.0',
      KEY,
    );
    expect(conns?.[0]?.chainId).toBe('stargaze-1');
  });

  it('refuses a single changed byte', () => {
    const sig = signed(registry, '13.4.0');
    expect(
      verifyRegistry(registry.replace('channel-30', 'channel-31'), sig, '13.3.0', KEY),
    ).toBeUndefined();
  });

  it('refuses a signature by any other key', () => {
    expect(verifyRegistry(registry, signed(registry, '13.4.0'), '13.3.0', OTHER)).toBeUndefined();
  });

  it('refuses a validly signed copy that is not newer (downgrade)', () => {
    expect(verifyRegistry(registry, signed(registry, '13.3.0'), '13.3.0', KEY)).toBeUndefined();
    expect(verifyRegistry(registry, signed(registry, '13.2.9'), '13.3.0', KEY)).toBeUndefined();
  });

  it('refuses a version that was changed after signing', () => {
    const sig = { ...signed(registry, '13.4.0'), version: '99.0.0' };
    expect(verifyRegistry(registry, sig, '13.3.0', KEY)).toBeUndefined();
  });

  it('refuses another format, another chain, or a body that is not a registry', () => {
    expect(
      verifyRegistry(registry, { ...signed(registry, '13.4.0'), format: 'v2' }, '13.3.0', KEY),
    ).toBeUndefined();
    const testnet = JSON.stringify({ chainId: 'penumbra-testnet', ibcConnections: [] });
    expect(verifyRegistry(testnet, signed(testnet, '13.4.0'), '13.3.0', KEY)).toBeUndefined();
    expect(verifyRegistry('not json', signed('not json', '13.4.0'), '13.3.0', KEY)).toBeUndefined();
  });

  it('never throws on garbage', () => {
    const junk = { format: 1, signature: '%%%' } as unknown as RegistrySig;
    expect(verifyRegistry(registry, junk, '13.3.0', KEY)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders dotted numbers and sorts junk lowest', () => {
    expect(compareVersions('13.10.0', '13.9.1')).toBe(1);
    expect(compareVersions('13.3', '13.3.0')).toBe(0);
    expect(compareVersions('nope', '0.0.1')).toBe(-1);
  });
});

describe('refreshForUnknownChains', () => {
  const live = [
    { chainId: 'osmosis-1', active: true },
    { chainId: 'stargaze-1', active: true },
    { chainId: 'old-1', active: false },
  ];
  const known = (c: string) => c === 'osmosis-1';
  const memory = () => {
    let s = { chains: [] as string[], fetchedAt: 0 };
    return { read: async () => s, write: async (n: typeof s) => void (s = n), peek: () => s };
  };

  it('does nothing while every live chain is known', async () => {
    const optIn = vi.fn(async () => true);
    const added = await refreshForUnknownChains([{ chainId: 'osmosis-1', active: true }], {
      known,
      optIn,
      fetch: async () => ['x'],
      state: memory(),
    });
    expect(added).toEqual([]);
    expect(optIn).not.toHaveBeenCalled();
  });

  it('asks once about a new live chain, and a no is not asked again', async () => {
    const state = memory();
    const optIn = vi.fn(async () => false);
    const fetch = vi.fn(async () => ['stargaze']);
    const deps = { known, optIn, fetch, state, now: () => 1000 };
    expect(await refreshForUnknownChains(live, deps)).toEqual([]);
    expect(await refreshForUnknownChains(live, { ...deps, now: () => 10 ** 12 })).toEqual([]);
    expect(optIn).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.peek().chains).toEqual(['stargaze-1']);
  });

  it('fetches on a yes, then at most daily', async () => {
    const state = memory();
    const fetch = vi.fn(async () => ['stargaze']);
    const deps = { known, optIn: async () => true, fetch, state };
    expect(await refreshForUnknownChains(live, { ...deps, now: () => 1000 })).toEqual(['stargaze']);
    await refreshForUnknownChains(live, { ...deps, now: () => 2000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await refreshForUnknownChains(live, { ...deps, now: () => 1000 + 25 * 3600 * 1000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
