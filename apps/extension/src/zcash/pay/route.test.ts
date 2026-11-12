import { describe, expect, it, vi } from 'vitest';
import type { DepositRequest } from '../../workers/transparent-deposit';
import { moveRoute, ownOf, publicMax, publicRoute, type OwnT } from './route';

const TEX = 'tex1zclnr35llscdedzrwdmemm70es05ngg9m2d3lv';
const PAY = { to: TEX, amountZat: '500000', mainnet: true };

const own = (balances: Record<string, [number, number]>): OwnT[] =>
  Object.entries(balances).map(([address, [zat, coins]], index) => ({
    index,
    address,
    zat: BigInt(zat),
    coins,
  }));

/** the wasm's plan for one input and no memo */
const planFor = (o: OwnT[]) =>
  vi.fn((r: DepositRequest) => {
    const have = Number(o.find(t => t.address === r.tAddress)?.zat ?? 0n);
    const need = Number(r.amountZat) + 10_000;
    return Promise.resolve({
      fee: '10000',
      change: String(Math.max(0, have - need)),
      short: String(Math.max(0, need - have)),
    });
  });

describe('publicRoute', () => {
  it('pays from the first address that covers it alone, memo-less', async () => {
    const o = own({ t0: [100, 1], t1: [1_000_000, 1] });
    const plan = planFor(o);
    expect(await publicRoute(o, plan, PAY)).toEqual({
      from: { index: 1, address: 't1' },
      fee: '10000',
    });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(plan.mock.calls[0]![0]).toMatchObject({ tAddress: 't1', tIndex: 1, memo: '', to: TEX });
  });

  it('never joins two addresses: two that cover it together are not a route', async () => {
    const o = own({ t0: [300_000, 1], t1: [300_000, 1] });
    expect(await publicRoute(o, planFor(o), PAY)).toBeUndefined();
  });
});

describe('moveRoute', () => {
  it('moves the amount and the one-input fee, so the fresh address keeps no change', () => {
    expect(moveRoute(PAY)).toEqual({ move: '510000', fee: '10000' });
  });
});

describe('publicMax', () => {
  it('is the most one address can pay, less the fee of spending all its coins', () => {
    // 3 coins: ZIP-317 prices 3 logical actions, 15,000
    expect(publicMax(own({ t0: [200_000, 1], t1: [1_000_000, 3] }))).toBe(985_000n);
    expect(publicMax(own({ t0: [5_000, 1] }))).toBe(0n);
  });
});

describe('ownOf', () => {
  it('sums each address by its index, skipping empty ones and any an open run is funding', () => {
    const utxos = [
      { address: 'a1', valueZat: 5n },
      { address: 'a2', valueZat: 7n },
      { address: 'a1', valueZat: 3n },
      { address: 'a3', valueZat: 9n },
    ];
    expect(ownOf(['a0', 'a1', 'a2', 'a3'], utxos, new Set([3]))).toEqual([
      { index: 1, address: 'a1', zat: 8n, coins: 2 },
      { index: 2, address: 'a2', zat: 7n, coins: 1 },
    ]);
  });
});
