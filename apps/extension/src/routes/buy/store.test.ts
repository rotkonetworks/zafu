import { beforeEach, describe, expect, it, vi } from 'vitest';
import noFee from '../../buy/fixtures/peer-quote-revolut-usd-100-nofee.json';
import { toOffer, type PeerQuoteRow } from '../../buy/fees';
import { advance, startBuy, type OpenBuy } from '../../buy/machine';

const m = vi.hoisted(() => ({
  writeOpenBuy: vi.fn(),
  sendUsdc: vi.fn(),
  quoteSwap: vi.fn(),
  usdcOf: vi.fn(),
}));

vi.mock('../../state', () => ({
  useStore: {
    getState: () => ({
      keyRing: {
        selectedKeyInfo: { id: 'w', type: 'mnemonic', name: 'main' },
        getMnemonic: () => Promise.resolve('seed'),
      },
    }),
  },
}));
vi.mock('../../state/pockets', () => ({ activeAccountIndex: () => 0 }));
vi.mock('../../state/keyring/network-worker', () => ({
  deriveAddressInWorker: vi.fn(),
  spawnNetworkWorker: vi.fn(),
}));
vi.mock('../../buy/store', () => ({
  readBuyPrefs: () => Promise.resolve({}),
  readOpenBuy: () => Promise.resolve(null),
  writeBuyPrefs: () => Promise.resolve(),
  writeOpenBuy: m.writeOpenBuy,
}));
vi.mock('../../buy/base-key', () => ({
  baseAddressOf: () => Promise.resolve(BASE),
  withBaseAccount: (_m: string, fn: (a: unknown) => unknown) => fn({ address: BASE }),
}));
vi.mock('../../buy/base-chain', async orig => ({
  ...(await orig<object>()),
  usdcOf: m.usdcOf,
  gasState: () => Promise.resolve({ have: 1n, need: 0n }),
  sendUsdc: m.sendUsdc,
}));
vi.mock('../../buy/near-leg', () => ({
  quoteSwap: m.quoteSwap,
  announceDeposit: () => Promise.resolve(),
  estimateSwap: vi.fn(),
  swapFacts: vi.fn(),
}));

const BASE = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94' as const;

import { TransferReverted } from '../../buy/base-chain';
import { buyStore, formKey, quoteIsCurrent, swapNow, type BuyState } from './store';

const offer = toOffer(noFee.responseObject.quotes[0] as PeerQuoteRow);
const released = (): OpenBuy =>
  advance(
    startBuy({ app: 'revolut', currency: 'usd', base: BASE, zcash: 'u1zec', offer }, 1),
    'released',
    { intentHash: '0xabc' },
    2,
  );
const LEG = {
  depositAddress: '0x' + 'd'.repeat(40),
  amountIn: offer.net.toString(),
  amountOut: '7368542',
  minAmountOut: '7294856',
  quotedAt: 3,
};

describe('the swap leg of a buy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.writeOpenBuy.mockResolvedValue(true);
    m.usdcOf.mockResolvedValue(offer.net);
    m.quoteSwap.mockResolvedValue(LEG);
    buyStore.setState({ buy: released(), base: BASE, error: undefined, overlay: null });
  });

  it('runs once however often it is asked, and saves the leg before the usdc moves', async () => {
    const order: string[] = [];
    m.writeOpenBuy.mockImplementation((b: OpenBuy) => {
      order.push(`save:${b.stage}:${b.depositTx ?? '-'}`);
      return Promise.resolve(true);
    });
    m.sendUsdc.mockImplementation(
      async (_a: unknown, _to: string, _amt: bigint, onSent: (h: string) => Promise<void>) => {
        order.push('send');
        await onSent('0xfeed');
        return '0xfeed';
      },
    );
    await Promise.all([swapNow(), swapNow(), swapNow()]);
    expect(m.quoteSwap).toHaveBeenCalledTimes(1);
    expect(m.sendUsdc).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['save:swapping:-', 'send', 'save:swapping:0xfeed']);
    expect(buyStore.getState().buy).toMatchObject({
      stage: 'swapping',
      near: LEG,
      depositTx: '0xfeed',
    });
  });

  it('a reverted transfer moved nothing: the buy goes back to wait for a fresh try', async () => {
    m.sendUsdc.mockImplementation(
      async (_a: unknown, _to: string, _amt: bigint, onSent: (h: string) => Promise<void>) => {
        await onSent('0xbad');
        throw new TransferReverted('0xbad');
      },
    );
    await swapNow();
    expect(buyStore.getState().buy).toMatchObject({ stage: 'released', near: undefined });
    expect(buyStore.getState().error).toMatch(/didn't go through/);
  });
});

describe('the amount screen', () => {
  const s = (over: Partial<BuyState>): BuyState =>
    ({ amount: '100', currency: 'usd', app: 'revolut', quoting: false, ...over }) as BuyState;
  const quotes = { kind: 'offers', offers: [offer], at: 1 } as const;

  it('continues only on offers made for the amount on screen', () => {
    const asked = formKey(s({}));
    expect(quoteIsCurrent(s({ quotes, quotedFor: asked }))).toBe(true);
    // typed 500 while the offers are still 100's
    expect(quoteIsCurrent(s({ quotes, quotedFor: asked, amount: '500' }))).toBe(false);
    expect(quoteIsCurrent(s({ quotes, quotedFor: asked, quoting: true }))).toBe(false);
    expect(quoteIsCurrent(s({ quotes, quotedFor: asked, app: 'wise' }))).toBe(false);
    // the same amount typed differently is the same amount
    expect(quoteIsCurrent(s({ quotes, quotedFor: asked, amount: '100.00' }))).toBe(true);
  });
});
