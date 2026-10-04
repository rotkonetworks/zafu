import { describe, expect, it, vi } from 'vitest';

const requestQuote = vi.hoisted(() => vi.fn());
vi.mock('../state/near-swap', () => ({
  requestQuote,
  checkSwapStatus: vi.fn(),
  submitDepositTx: vi.fn(),
}));

import { checkLeg, estimateSwap, quoteSwap, NEAR_BASE_USDC, NEAR_ZEC } from './near-leg';

const quote = (q: Record<string, unknown>, asked: Record<string, unknown> = {}) => ({
  quoteRequest: {
    originAsset: NEAR_BASE_USDC,
    destinationAsset: NEAR_ZEC,
    recipient: 'u1zec',
    refundTo: '0xabc',
    dry: false,
    ...asked,
  },
  quote: {
    amountOut: '7368542',
    amountIn: '97107843',
    minAmountOut: '7294856',
    deadline: new Date(Date.now() + 2 * 3600_000).toISOString(),
    ...q,
  },
});
const DEP = '0x' + 'de'.repeat(20);

describe('the swap leg of a buy', () => {
  it('charges no zafu fee (one fee per buy, on the peer side) and refunds to the base key', async () => {
    requestQuote.mockResolvedValueOnce(quote({ amountInUsd: '97.10', amountOutUsd: '95.65' }));
    const e = await estimateSwap(97_107_843n, '0xabc', 'u1zec');
    expect(requestQuote).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dry: true,
        appFeeBps: 0,
        originAsset: NEAR_BASE_USDC,
        destinationAsset: NEAR_ZEC,
        refundTo: '0xabc',
        recipient: 'u1zec',
      }),
    );
    expect(e.cost).toBe(1_450_000n);
  });

  it('takes a real quote only for the usdc that arrived, and needs its deposit address', async () => {
    requestQuote.mockResolvedValueOnce(quote({ depositAddress: DEP }));
    const leg = await quoteSwap(97_107_843n, '0xabc', 'u1zec');
    expect(requestQuote.mock.lastCall?.[0]).toMatchObject({ appFeeBps: 0, amount: '97107843' });
    expect(requestQuote.mock.lastCall?.[0].dry).toBeUndefined();
    expect(leg).toMatchObject({ depositAddress: DEP, minAmountOut: '7294856' });
    requestQuote.mockResolvedValueOnce(quote({ depositAddress: '' }));
    await expect(quoteSwap(97_107_843n, '0xabc', 'u1zec')).rejects.toThrow(/no deposit address/);
  });

  it("refuses a quote that isn't the swap asked, before anything is signed", () => {
    const want = { usdc: 97_107_843n, base: '0xabc' as const, zcash: 'u1zec' };
    const ok = quote({ depositAddress: DEP });
    expect(() => checkLeg(ok as never, want)).not.toThrow();
    const bad = (q: Record<string, unknown>, asked?: Record<string, unknown>) => () =>
      checkLeg(quote({ depositAddress: DEP, ...q }, asked) as never, want);
    // more usdc than arrived (a refund's leftover, say) is never sent
    expect(bad({ amountIn: '197107843' })).toThrow(/another amount/);
    expect(bad({ depositAddress: 'bc1qnotbase' })).toThrow(/isn't on base/);
    expect(bad({}, { recipient: 'u1someoneelse' })).toThrow(/another swap/);
    expect(bad({}, { refundTo: '0xdef' })).toThrow(/another swap/);
    expect(bad({}, { destinationAsset: 'nep141:eth.omft.near' })).toThrow(/another swap/);
    expect(bad({ deadline: new Date(Date.now() + 60_000).toISOString() })).toThrow(/too soon/);
    expect(bad({ deadline: 'whenever' })).toThrow(/too soon/);
    // no deadline of its own: the echoed request's counts, as long as it leaves time
    const later = new Date(Date.now() + 3600_000).toISOString();
    expect(bad({ deadline: undefined }, { deadline: later })).not.toThrow();
    expect(bad({ deadline: undefined }, { deadline: new Date().toISOString() })).toThrow(
      /too soon/,
    );
    expect(bad({ deadline: undefined })).toThrow(/too soon/);
    expect(bad({ minAmountOut: '6000000' })).toThrow(/slippage/);
    expect(bad({ minAmountOut: undefined })).toThrow(/slippage/);
  });
});
