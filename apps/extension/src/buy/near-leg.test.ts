import { describe, expect, it, vi } from 'vitest';

const requestQuote = vi.hoisted(() => vi.fn());
vi.mock('../state/near-swap', () => ({
  requestQuote,
  checkSwapStatus: vi.fn(),
  submitDepositTx: vi.fn(),
}));

import { estimateSwap, quoteSwap, NEAR_BASE_USDC, NEAR_ZEC } from './near-leg';

const quote = (q: Record<string, unknown>) => ({
  quote: { amountOut: '7368542', amountIn: '97107843', ...q },
});

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
    requestQuote.mockResolvedValueOnce(quote({ depositAddress: '0xdep', minAmountOut: '7294856' }));
    const leg = await quoteSwap(97_107_843n, '0xabc', 'u1zec');
    expect(requestQuote.mock.lastCall?.[0]).toMatchObject({ appFeeBps: 0, amount: '97107843' });
    expect(requestQuote.mock.lastCall?.[0].dry).toBeUndefined();
    expect(leg).toMatchObject({ depositAddress: '0xdep', minAmountOut: '7294856' });
    requestQuote.mockResolvedValueOnce(quote({ depositAddress: '' }));
    await expect(quoteSwap(1n, '0xabc', 'u1zec')).rejects.toThrow();
  });
});
