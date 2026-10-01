import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const egress = vi.hoisted(() => ({ on: false, allowOnAsk: false, asked: 0 }));
vi.mock('../net/egress-opt-in', () => ({
  readEgressView: () => Promise.resolve([{ id: 'thorname', on: egress.on }]),
  requestEgressOptIn: (id: string) => {
    egress.asked++;
    return Promise.resolve(id === 'thorname' && (egress.on || egress.allowOnAsk));
  },
}));

import {
  aliasFor,
  clearThorNameCache,
  isThorName,
  lookupThorName,
  thorChainOf,
  type ThorNameRecord,
} from './thorname';

const ALICE: ThorNameRecord = {
  name: 'alice',
  aliases: [
    { chain: 'BTC', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' },
    { chain: 'ZEC', address: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf' },
    { chain: 'THOR', address: 'thor15cl4m94khtlt20p4s6k5vkfhrqxasl2r7rgsv6' },
  ],
};

/** a thornode answering one name (anything else is thorchain's 400) */
const thornode = (status = 200, body: unknown = ALICE) => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url);
      const known = url.endsWith('/alice');
      return Promise.resolve(
        new Response(JSON.stringify(known ? body : { message: 'not found' }), {
          status: known ? status : 400,
        }),
      );
    }),
  );
  return urls;
};

beforeEach(() => {
  egress.on = false;
  egress.allowOnAsk = false;
  egress.asked = 0;
  clearThorNameCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('what counts as a thorname', () => {
  it('takes thorchain-shaped names', () => {
    for (const n of ['alice', 'a', 'ss', 'x_y+z-1', 'a-'.repeat(15)]) {
      expect(isThorName(n)).toBe(true);
    }
  });

  it('skips memo syntax, urls, handles and over-long strings', () => {
    for (const n of ['', 'alice.btc', 'a:b', '/alice', 'zcash.me/alice', 'a b', 'a'.repeat(31)]) {
      expect(isThorName(n)).toBe(false);
    }
  });

  it('never treats an address as a name', () => {
    for (const a of [
      // base58 within thorchain's 30 characters: btc burn, doge, ltc legacy
      '1111111111111111111114oLvT2',
      'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'.slice(0, 30),
      'LZ3bx1HMh6RbTLAqmJyU3dV6Csu7cd2Y',
      // bech32 and hex
      'cosmos1qypqxpq9qcrsszg2pvxq6',
      '0xdeadbeef',
      // and the long ones
      't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf',
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
    ]) {
      expect(isThorName(a)).toBe(false);
    }
  });
});

describe('alias per chain', () => {
  it('maps zafu networks to thorchain chains', () => {
    expect(thorChainOf('zcash')).toBe('ZEC');
    expect(thorChainOf('bitcoin')).toBe('BTC');
    expect(thorChainOf('cosmos', 'cosmoshub-4')).toBe('GAIA');
    expect(thorChainOf('cosmos', 'cosmoshub')).toBe('GAIA');
    // chains thorchain has no aliases for
    expect(thorChainOf('cosmos', 'osmosis-1')).toBeUndefined();
    expect(thorChainOf('cosmos')).toBeUndefined();
    expect(thorChainOf('penumbra')).toBeUndefined();
  });

  it('picks the alias for the chain being paid', () => {
    expect(aliasFor(ALICE, 'ZEC')).toBe('t1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf');
    expect(aliasFor(ALICE, 'btc')).toBe('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
    expect(aliasFor(ALICE, 'ETH')).toBeUndefined();
    expect(aliasFor({ name: 'x' }, 'BTC')).toBeUndefined();
  });
});

describe('lookups wait for consent', () => {
  it('sends nothing before the user opts in', async () => {
    const urls = thornode();
    expect(await lookupThorName('alice', 'ZEC', false)).toEqual({ kind: 'ask' });
    expect(egress.asked).toBe(0);
    expect(urls).toEqual([]);
  });

  it('sends nothing when the user declines the ask', async () => {
    const urls = thornode();
    expect(await lookupThorName('alice', 'ZEC', true)).toEqual({ kind: 'declined' });
    expect(egress.asked).toBe(1);
    expect(urls).toEqual([]);
  });

  it('looks the name up once allowed, and only once', async () => {
    egress.allowOnAsk = true;
    const urls = thornode();
    expect(await lookupThorName('Alice', 'ZEC', true)).toEqual({
      kind: 'found',
      name: 'alice',
      chain: 'ZEC',
      address: 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf',
    });
    expect(urls).toEqual(['https://thornode.ninerealms.com/thorchain/thorname/alice']);
    egress.on = true;
    expect(await lookupThorName('alice', 'BTC', false)).toMatchObject({ kind: 'found' });
    expect(urls).toHaveLength(1);
  });

  it('says calmly when the name has no address on this chain, or does not exist', async () => {
    egress.on = true;
    thornode();
    expect(await lookupThorName('alice', 'ETH', false)).toEqual({
      kind: 'no-alias',
      name: 'alice',
      chain: 'ETH',
    });
    expect(await lookupThorName('nobody', 'ZEC', false)).toEqual({ kind: 'missing' });
  });

  it('tries the next node, and forgets a failure so a retry asks again', async () => {
    egress.on = true;
    const urls = thornode(503);
    expect(await lookupThorName('alice', 'ZEC', false)).toEqual({ kind: 'error' });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(
      'https://gateway.liquify.com/chain/thorchain_api/thorchain/thorname/alice',
    );
    thornode();
    expect(await lookupThorName('alice', 'ZEC', false)).toMatchObject({ kind: 'found' });
  });
});
