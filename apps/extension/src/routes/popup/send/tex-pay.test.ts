import { describe, expect, it, vi } from 'vitest';
import type { DepositRequest } from '../../../workers/transparent-deposit';
import { payTex, texRoute, TEX_STOPPED, type TexDeps } from './tex-pay';

const TEX = 'tex1zclnr35llscdedzrwdmemm70es05ngg9m2d3lv';
const PAY = { to: TEX, amountZat: '500000', mainnet: true };

/** each address's balance; the plan is the wasm's for one input and no memo */
const depsFor = (balances: Record<string, number>, over: Partial<TexDeps> = {}) => {
  const plan = vi.fn((r: DepositRequest) => {
    const have = balances[r.tAddress] ?? 0;
    const need = Number(r.amountZat) + 10_000;
    return Promise.resolve({
      fee: '10000',
      change: String(Math.max(0, have - need)),
      short: String(Math.max(0, need - have)),
    });
  });
  const deps: TexDeps = {
    own: () =>
      Promise.resolve(
        ['t0', 't1'].map((address, index) => ({
          index,
          address,
          zat: BigInt(balances[address] ?? 0),
        })),
      ),
    plan,
    claim: vi.fn(() => Promise.resolve({ index: 21, address: 'fresh' })),
    move: vi.fn((to: string, zat: string) => {
      balances[to] = (balances[to] ?? 0) + Number(zat);
      return Promise.resolve('move-txid');
    }),
    mined: vi.fn(() => Promise.resolve(100)),
    pay: vi.fn(r => Promise.resolve({ txid: `paid-from-${r.tAddress}`, fee: r.reviewedFee })),
    sleep: () => Promise.resolve(),
    step: () => undefined,
    live: () => true,
    ...over,
  };
  return deps;
};

describe('texRoute', () => {
  it('picks the first own address that covers the payment and its fee', async () => {
    expect(await texRoute(depsFor({ t0: 100, t1: 1_000_000 }), PAY)).toEqual({
      from: { index: 1, address: 't1' },
      fee: '10000',
    });
  });

  it('moves the amount and the one-input fee when no address covers it', async () => {
    const deps = depsFor({ t0: 200_000 });
    expect(await texRoute(deps, PAY)).toEqual({ move: '510000', fee: '10000' });
    // an address holding less than the amount is never planned
    expect(deps.plan).not.toHaveBeenCalled();
  });
});

describe('payTex', () => {
  it('pays from a transparent address that already covers it, moving nothing', async () => {
    const deps = depsFor({ t1: 1_000_000 });
    const sent = await payTex(deps, PAY, await texRoute(deps, PAY));
    expect(sent).toEqual({ txid: 'paid-from-t1', fee: '10000' });
    expect(deps.pay).toHaveBeenCalledWith(
      expect.objectContaining({
        tAddress: 't1',
        tIndex: 1,
        to: TEX,
        memo: '',
        amountZat: '500000',
      }),
    );
    expect(deps.move).not.toHaveBeenCalled();
    expect(deps.claim).not.toHaveBeenCalled();
  });

  it('funds a fresh address with exactly the amount and fee, then pays from it once mined', async () => {
    const mined = vi
      .fn<(txid: string) => Promise<number | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(100);
    const deps = depsFor({ t0: 200_000 }, { mined });
    const sent = await payTex(deps, PAY, await texRoute(deps, PAY));
    expect(deps.move).toHaveBeenCalledWith('fresh', '510000');
    expect(mined).toHaveBeenCalledTimes(2);
    expect(sent).toEqual({ txid: 'paid-from-fresh', fee: '10000', moveTxid: 'move-txid' });
    expect(deps.pay).toHaveBeenCalledWith(
      expect.objectContaining({ tAddress: 'fresh', tIndex: 21, reviewedFee: '10000', memo: '' }),
    );
  });

  it('waits for the mined coin to show on the fresh address before paying', async () => {
    const balances: Record<string, number> = {};
    let shows = false;
    const deps = depsFor(balances, {
      move: vi.fn(() => Promise.resolve('move-txid')),
      sleep: () => {
        balances.fresh = 510_000;
        shows = true;
        return Promise.resolve();
      },
    });
    await payTex(deps, PAY, { move: '510000', fee: '10000' });
    expect(shows).toBe(true);
    expect(deps.pay).toHaveBeenCalledTimes(1);
  });

  it('a stop while the move waits pays nothing and says where the zec is', async () => {
    let live = true;
    const deps = depsFor(
      {},
      {
        mined: () => Promise.resolve(undefined),
        sleep: () => {
          live = false;
          return Promise.resolve();
        },
        live: () => live,
      },
    );
    await expect(payTex(deps, PAY, { move: '510000', fee: '10000' })).rejects.toThrow(TEX_STOPPED);
    expect(deps.pay).not.toHaveBeenCalled();
  });

  it('a failed move pays nothing', async () => {
    const deps = depsFor({}, { move: () => Promise.reject(new Error('insufficient funds')) });
    await expect(payTex(deps, PAY, { move: '510000', fee: '10000' })).rejects.toThrow(
      /insufficient/,
    );
    expect(deps.pay).not.toHaveBeenCalled();
  });
});
