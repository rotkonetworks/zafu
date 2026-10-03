import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../net/egress-opt-in', () => ({
  readEgressView: () => Promise.resolve([{ id: 'near-swap', on: true, why: 'you-allowed' }]),
  requestEgressOptIn: () => Promise.resolve(true),
}));

import { invert, priced } from './market';
import {
  costOf,
  figure,
  toUnits,
  type Quote,
  type QuoteRequest,
  type SwapProvider,
} from './provider';

const ETH = { symbol: 'ETH', chain: 'eth', decimals: 18 };
const out = (over: Partial<QuoteRequest> = {}): QuoteRequest => ({
  direction: 'from_zec',
  token: ETH,
  amountIn: '0.1',
  zcashAddress: 'u1x',
  otherAddress: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2',
  ...over,
});
const quote = (amountOut: bigint, parts: { label: string; bps: number }[] = []): Quote => ({
  route: 'thor',
  amountOut,
  amountOutText: figure(amountOut, 18),
  amountInText: '0.1',
  cost: costOf(parts.map(p => ({ ...p, out: 0n }))),
  depositAddress: '',
  recipient: '',
  raw: undefined,
});
// 1click's list on 2026-10-04
const market = { pIn: 1295.61, pOut: 2685.21 };

afterEach(() => vi.restoreAllMocks());

describe('amounts as shown', () => {
  it('six significant figures, rounded down, whole digits kept; exact inside', () => {
    expect(figure(48_111_488_536_361_170n, 18)).toBe('0.0481114');
    expect(figure(643_267_087n, 8)).toBe('6.43267');
    expect(figure(123_456_789_012_345n, 8)).toBe('1234567');
    expect(figure(100_000_000n, 8)).toBe('1');
    expect(figure(0n, 8)).toBe('0');
  });
});

describe('a route against the market', () => {
  it("near's live 0.1 zec -> eth: about -0.3% vs market", () => {
    const q = priced(quote(48_111_488_536_361_170n), out({ direction: 'from_zec' }), market);
    expect(q.vsMarketBps).toBe(-29);
  });

  it("thorchain's thin pool: listed fees 0.39%, the rest shown as the price gap", () => {
    // 0.1 zec at the pool's own price ($1271 vs $1298 market), less 0.39% in fees
    const got = BigInt(Math.round(((0.1 * 1271) / 2685.21) * (1 - 0.0039) * 1e18));
    const q = priced(quote(got, [{ label: 'thorchain', bps: 39 }]), out(), market);
    expect(q.vsMarketBps).toBe(-228);
    expect(q.cost?.parts.at(-1)).toMatchObject({ label: "vs near's price list", bps: 189 });
    expect(q.cost?.bps).toBe(228);
  });

  it('counts the zip-317 fee of the send out of zec, and nothing into zec', () => {
    const q = priced(quote(48_111_488_536_361_170n), out({ sourceFeeZat: '15000' }), market);
    expect(q.cost?.parts[0]).toMatchObject({
      label: 'network fee out',
      bps: 15,
      inText: '~0.00015 zec',
    });
    expect(q.vsMarketBps).toBe(-44);
    const into = priced(
      { ...quote(toUnits('0.1', 8)), amountInText: '0.05' },
      out({ direction: 'into_zec', sourceFeeZat: '15000' }),
    );
    expect(into.cost?.parts.some(p => p.label === 'network fee out')).toBe(false);
  });

  it('says nothing against the market when no market price is known', () => {
    expect(priced(quote(1n), out()).vsMarketBps).toBeUndefined();
  });
});

describe('quoting by what arrives on a route with no exact-output mode', () => {
  /** a pool that pays 0.0481 eth per 0.1 zec, worse as the amount grows */
  const pool = (
    rate = (zat: bigint) => (zat * 481_000_000_000n * (1_000_000_000n - zat)) / 1_000_000_000n,
  ): SwapProvider => ({
    id: 'thor',
    tokens: () => Promise.resolve([]),
    quote: vi.fn((r: QuoteRequest) => Promise.resolve(quote(rate(toUnits(r.amountIn, 8))))),
  });

  it('starts from the market, refines in proportion, and says about', async () => {
    const p = pool();
    const q = await invert(p, out({ exactOut: '0.05' }), market);
    const want = toUnits('0.05', 18);
    const off = q.amountOut > want ? q.amountOut - want : want - q.amountOut;
    expect(off * 200n <= want).toBe(true);
    expect(q.approx).toBe(true);
    expect((p.quote as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('falls back to "quotes by what you pay" when it does not settle', async () => {
    const p = pool(() => 1n);
    await expect(invert(p, out({ exactOut: '0.05' }), market)).rejects.toThrow(
      'thorchain quotes by what you pay',
    );
    await expect(
      invert(pool(), out({ exactOut: '0.05', amountIn: '' }), undefined),
    ).rejects.toThrow('quotes by what you pay');
  });
});
