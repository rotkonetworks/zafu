import { describe, expect, it, vi } from 'vitest';
import {
  baseDrips,
  baseSends,
  type BaseLogs,
  capacity,
  injectiveGrants,
  makeStats,
  units,
  type BaseChain,
  type Source,
} from './stats';

const INJ = 10n ** 18n;

describe('capacity', () => {
  it('divides what is above the reserve by the per-person cost', () => {
    expect(capacity(INJ, INJ / 10n, INJ / 1000n)).toBe(900);
  });
  it('is zero at or below the reserve', () => {
    expect(capacity(INJ / 10n, INJ / 10n, INJ / 1000n)).toBe(0);
    expect(capacity(0n, INJ / 10n, INJ / 1000n)).toBe(0);
  });
});

describe('units', () => {
  it('trims to a short decimal', () => {
    expect(units(1_000_000_000_000_000n)).toBe('0.001');
    expect(units(20_000_000_000_000n)).toBe('0.00002');
    expect(units(3n * INJ)).toBe('3');
    expect(units(5n)).toBe('0');
  });
});

const source = (over: Partial<Source> = {}): Source => ({
  symbol: 'INJ',
  sponsor: 'inj1sponsor',
  addressUrl: 'https://x/addr',
  txUrl: h => `https://x/tx/${h}`,
  unit: INJ / 1000n,
  reserve: INJ / 10n,
  dailyCap: 200,
  today: () => 7,
  balance: () => Promise.resolve(INJ),
  records: () => Promise.resolve([{ time: 't', txHash: 'AB', to: 'inj1a', amount: INJ / 1000n }]),
  ...over,
});

describe('makeStats', () => {
  it('aggregates balance, capacity, today and records', async () => {
    const s = await makeStats({ injective: source() })();
    expect(s.base).toBeNull();
    expect(s.injective).toMatchObject({
      balance: '1',
      capacity: 900,
      today: 7,
      dailyCap: 200,
      sponsor: 'inj1sponsor',
      records: [{ txHash: 'AB', amount: '0.001', url: 'https://x/tx/AB' }],
    });
  });

  it('caps records at 20', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      time: 't',
      txHash: String(i),
      to: 'a',
      amount: 1n,
    }));
    const s = await makeStats({ injective: source({ records: () => Promise.resolve(many) }) })();
    expect(s.injective.records).toHaveLength(20);
  });

  it('reads unknown, not zero, when the chain fails', async () => {
    const s = await makeStats({
      injective: source({
        balance: () => Promise.reject(new Error('down')),
        records: () => Promise.reject(new Error('down')),
      }),
    })();
    expect(s.injective).toMatchObject({ balance: null, capacity: null, records: [] });
  });

  it('reads the chain once a minute, but the daily count live', async () => {
    let t = 0;
    let n = 0;
    const balance = vi.fn(() => Promise.resolve(INJ));
    const stats = makeStats({ injective: source({ balance, today: () => n }) }, () => t);
    await stats();
    n = 9;
    t = 59_000;
    expect((await stats()).injective.today).toBe(9);
    t = 60_000;
    await stats();
    expect(balance).toHaveBeenCalledTimes(2);
  });
});

describe('injectiveGrants', () => {
  const grant = (grantee: string, spend: string, wrapped = true) => ({
    '@type': '/cosmos.feegrant.v1beta1.MsgGrantAllowance',
    grantee,
    allowance: wrapped
      ? { allowance: { spend_limit: [{ denom: 'inj', amount: spend }] } }
      : { spend_limit: [{ denom: 'inj', amount: spend }] },
  });
  const tx = (txhash: string, messages: unknown[], code = 0) => ({
    txhash,
    code,
    timestamp: '2026-11-01T10:00:00Z',
    tx: { body: { messages } },
  });

  it('searches by sender and keeps successful grants, not revokes', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        Response.json({
          tx_responses: [
            tx('A', [
              { '@type': '/cosmos.feegrant.v1beta1.MsgRevokeAllowance' },
              grant('inj1g', '5'),
            ]),
            tx('B', [grant('inj1h', '7', false)], 5),
            tx('C', [grant('inj1i', '9', false)]),
          ],
        }),
      ),
    );
    const out = await injectiveGrants('https://lcd/', 'inj1sponsor', fetchFn as never);
    expect(out.map(r => [r.txHash, r.to, r.amount])).toEqual([
      ['A', 'inj1g', 5n],
      ['C', 'inj1i', 9n],
    ]);
    const url = decodeURIComponent((fetchFn.mock.calls[0] as unknown as string[])[0]!);
    expect(url).toContain("query=message.sender='inj1sponsor'");
    expect(url).toContain('ORDER_BY_DESC');
  });

  it('throws when the LCD errors', async () => {
    const fetchFn = () => Promise.resolve(new Response('', { status: 500 }));
    await expect(injectiveGrants('https://lcd', 'inj1', fetchFn as never)).rejects.toThrow('500');
  });
});

describe('baseSends', () => {
  const me = '0xAbC0000000000000000000000000000000000001';
  /** a chain at height 100000 where the sponsor sends in these blocks */
  const fakeChain = (sendBlocks: number[]) => {
    const nonceAt = vi.fn((_: string, b: bigint) =>
      Promise.resolve(sendBlocks.filter(s => BigInt(s) <= b).length),
    );
    const chain: BaseChain = {
      head: () => Promise.resolve(100_000n),
      nonceAt,
      block: n =>
        Promise.resolve({
          timestamp: 1_000_000n + n,
          transactions: [
            { hash: `0xother${n}`, from: '0xdead', to: '0xbeef', value: 1n },
            { hash: `0xtx${n}`, from: me.toLowerCase(), to: '0xrecipient', value: 20n },
          ],
        }),
    };
    return { chain, nonceAt };
  };

  it('finds the sponsor sends, newest first, with few rpc calls', async () => {
    const { chain, nonceAt } = fakeChain([70_000, 99_000, 99_500]);
    const out = await baseSends(chain, me);
    expect(out.map(r => r.txHash)).toEqual(['0xtx99500', '0xtx99000', '0xtx70000']);
    expect(out[0]).toMatchObject({ to: '0xrecipient', amount: 20n });
    expect(nonceAt.mock.calls.length).toBeLessThan(80);
  });

  it('costs two calls when nothing was sent', async () => {
    const { chain, nonceAt } = fakeChain([]);
    expect(await baseSends(chain, me)).toEqual([]);
    expect(nonceAt).toHaveBeenCalledTimes(2);
  });
});

describe('baseDrips', () => {
  const me = '0xAbC0000000000000000000000000000000000001';
  const log = (block: number, from = me) => ({
    from,
    txHash: `0xt${block}`,
    block: BigInt(block),
    to: '0xr',
    amount: 20n,
  });
  const fake = (all: ReturnType<typeof log>[]) => {
    const ranges: [bigint, bigint][] = [];
    const logs: BaseLogs = {
      head: () => Promise.resolve(100_000n),
      logs: (from, to) => {
        ranges.push([from, to]);
        return Promise.resolve(all.filter(l => l.block >= from && l.block <= to));
      },
      timestamp: b => Promise.resolve(1000n + b),
    };
    return { logs, ranges };
  };

  it('drops events from other callers and returns newest first with block times', async () => {
    const { logs } = fake([log(99_000), log(99_500, '0xsomeoneelse'), log(99_900)]);
    const out = await baseDrips(logs, me.toLowerCase());
    expect(out.map(r => r.txHash)).toEqual(['0xt99900', '0xt99000']);
    expect(out[0]?.time).toBe(new Date((1000 + 99_900) * 1000).toISOString());
  });

  it('walks back in 10k chunks over about a day', async () => {
    const { logs, ranges } = fake([]);
    await baseDrips(logs, me);
    expect(ranges[0]).toEqual([90_001n, 100_000n]);
    expect(ranges).toHaveLength(5);
    expect(ranges.at(-1)?.[0]).toBe(56_800n);
  });

  it('stops at 20 records without reading older chunks', async () => {
    const many = Array.from({ length: 30 }, (_, i) => log(95_000 + i));
    const { logs, ranges } = fake(many);
    const out = await baseDrips(logs, me);
    expect(out).toHaveLength(20);
    expect(out[0]?.txHash).toBe('0xt95029');
    expect(ranges).toHaveLength(1);
  });
});
