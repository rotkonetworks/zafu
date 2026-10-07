import { beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({
  move: vi.fn(),
  pay: vi.fn(),
  plan: vi.fn(),
  coldMove: vi.fn(),
  coldPay: vi.fn(),
  coldDone: vi.fn(),
}));
vi.mock('../keyring/network-worker', () => ({
  buildSendTxInWorker: worker.move,
  sendTransparentDepositInWorker: worker.pay,
  planTransparentDepositInWorker: worker.plan,
  buildSendTxPcztInWorker: worker.coldMove,
  buildColdDepositInWorker: worker.coldPay,
  completeColdDepositInWorker: worker.coldDone,
  applySignatureContributionsInWorker: vi.fn(),
}));
vi.mock('../../workers/transparent-deposit', async orig => ({
  ...(await orig<object>()),
  checkVault: () => Promise.resolve(),
}));
const opens = vi.hoisted(() => ({ patch: vi.fn(() => Promise.resolve(true)) }));
vi.mock('./open-swaps', async orig => ({ ...(await orig<object>()), patchOpenSwap: opens.patch }));

import {
  MOVED_POLL_MS,
  depositOf,
  nextLeg,
  openSwapUnlock,
  runThorOut,
  runs,
  swapUnlocked,
  type Legs,
  type RunDeps,
} from './thor-out';
import { resumeSwapLegs, runSwapLegs, swapRound, type LegContext } from './thor-legs';
import type { OpenSwap } from './open-swaps';
import { ZignerDeclined } from '../../signing/zigner-round';

const NOW = 1_800_000_000_000;
const T = { index: 7, address: 't1SwapOwnAddressxxxxxxxxxxxxxxxxx' };
const VAULT = 't1VaultAddressyyyyyyyyyyyyyyyyyyyy';
const MEMO = '=:BTC.BTC:bc1qdest:155875/1/0';

const swap = (patch: Partial<OpenSwap> = {}): OpenSwap => ({
  v: 1,
  id: `s-${Math.random()}`,
  wallet: 'vault#1',
  route: 'thor',
  direction: 'from_zec',
  token: { symbol: 'BTC', chain: 'btc', decimals: 8 },
  amountIn: '0.1',
  amountInText: '0.1',
  amountOut: '157450',
  amountOutText: '0.0015745',
  depositAddress: VAULT,
  memo: MEMO,
  recipient: 'bc1qdest',
  otherAddress: 'bc1qdest',
  expiresAt: NOW + 15 * 60_000,
  swapT: T,
  depositFee: '12000',
  stage: 'thor-out',
  at: NOW,
  ...patch,
});

const plan = (short: string) => ({ fee: '12000', change: '0', short });

/** a run's world: plans in order, saves recorded, no real waits */
const world = (...plans: string[]) => {
  const saved: Partial<OpenSwap>[] = [];
  const slept: number[] = [];
  const deps: RunDeps = {
    plan: vi.fn(() => Promise.resolve(plan(plans.length > 1 ? plans.shift()! : plans[0]!))),
    save: p => (saved.push(p), Promise.resolve()),
    sleep: ms => (slept.push(ms), Promise.resolve()),
    now: () => NOW,
  };
  return { deps, saved, slept };
};

const legs = (ready = () => Promise.resolve(true)): Legs & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    ready,
    move: vi.fn(short => (calls.push(`move ${short}`), Promise.resolve('aa'.repeat(32)))),
    pay: vi.fn(req => (calls.push(`pay ${req.amountZat}`), Promise.resolve('ee'.repeat(32)))),
  };
};

beforeEach(async () => {
  vi.clearAllMocks();
  await chrome.storage.session.clear();
});

describe('what a thorchain swap out does next', () => {
  it('moves when short, waits once moved, pays when funded, never moves on a dying price', () => {
    const exp = NOW + 15 * 60_000;
    expect(nextLeg(plan('10012000'), false, exp, NOW)).toBe('move');
    expect(nextLeg(plan('10012000'), true, exp, NOW)).toBe('wait');
    expect(nextLeg(plan('0'), true, exp, NOW)).toBe('pay');
    expect(nextLeg(plan('0'), false, exp, NOW)).toBe('pay');
    expect(nextLeg(plan('10012000'), false, NOW + 60_000, NOW)).toBe('expired');
    // moved zec waits for the network even past the price, then says so
    expect(nextLeg(plan('10012000'), true, NOW - 1, NOW)).toBe('wait');
    expect(nextLeg(plan('0'), true, NOW - 1, NOW)).toBe('expired');
  });

  it('signs exactly the reviewed deposit: the swap address, its index, the vault, memo and fee', () => {
    expect(depositOf(swap())).toEqual({
      tAddress: T.address,
      tIndex: 7,
      to: VAULT,
      amountZat: '10000000',
      memo: MEMO,
      mainnet: true,
      reviewedFee: '12000',
    });
  });
});

describe('one press runs both legs', () => {
  it('moves the reviewed shortfall, waits for it to confirm, then pays, with no second ask', async () => {
    const s = swap();
    const { deps, saved, slept } = world('10012000', '10012000', '0');
    const l = legs();
    await runThorOut(s, l, deps, plan('10012000'));
    expect(l.calls).toEqual(['move 10012000', 'pay 10000000']);
    expect(slept.every(ms => ms === MOVED_POLL_MS)).toBe(true);
    expect(saved).toEqual([
      { moveTxid: 'aa'.repeat(32) },
      { stage: 'sent', depositTxid: 'ee'.repeat(32) },
    ]);
    expect(runs.getState()[s.id]).toEqual({ at: 'sent', moved: true, txid: 'ee'.repeat(32) });
  });

  it('the first plan is the one reviewed: nothing is moved that was not shown', async () => {
    const { deps } = world('0');
    const l = legs();
    await runThorOut(swap(), l, deps, plan('10012000'));
    expect(l.calls[0]).toBe('move 10012000');
  });

  it("asks again before moving when the price can't outlast the move", async () => {
    const s = swap({ expiresAt: NOW + 60_000 });
    const l = legs();
    await runThorOut(s, l, world('10012000').deps);
    expect(l.calls).toEqual([]);
    expect(runs.getState()[s.id]).toEqual({ at: 'expired', moved: false });
  });

  it('a failed deposit after the move says where the zec sits, and stops', async () => {
    const s = swap();
    const l = legs();
    l.pay = () => Promise.reject(new Error('insufficient funds'));
    await runThorOut(s, l, world('10012000', '0').deps, plan('10012000'));
    expect(runs.getState()[s.id]).toMatchObject({ at: 'stopped', moved: true });
    expect((runs.getState()[s.id] as { error: string }).error).toMatch(/nothing went to the vault/);
  });

  it('stepping back from zigner holds the run; nothing is reported as failed', async () => {
    const s = swap();
    const l = legs();
    l.move = () => Promise.reject(new ZignerDeclined());
    await runThorOut(s, l, world('10012000').deps, plan('10012000'));
    expect(runs.getState()[s.id]).toEqual({ at: 'held', moved: false });
  });
});

describe('the swap unlock: once for both legs, dropped after', () => {
  it('covers the move and the deposit, then is gone', async () => {
    const s = swap();
    await openSwapUnlock(s.id, s.expiresAt, NOW);
    const l = legs(() => swapUnlocked(s.id, NOW));
    await runThorOut(s, l, world('10012000', '0').deps, plan('10012000'));
    expect(l.calls).toEqual(['move 10012000', 'pay 10000000']);
    expect(await swapUnlocked(s.id, NOW)).toBe(false);
    expect(await chrome.storage.session.get('swapUnlock')).toEqual({});
  });

  it('is this swap only, and no longer than its price or the grace window', async () => {
    const s = swap({ expiresAt: NOW + 5 * 60_000 });
    await openSwapUnlock(s.id, s.expiresAt, NOW);
    expect(await swapUnlocked(s.id, NOW)).toBe(true);
    expect(await swapUnlocked('another swap', NOW)).toBe(false);
    expect(await swapUnlocked(s.id, NOW + 5 * 60_000)).toBe(false);
    await openSwapUnlock(s.id, undefined, NOW);
    expect(await swapUnlocked(s.id, NOW + 15 * 60_000)).toBe(false);
  });

  it('a stopped swap drops it too', async () => {
    const s = swap();
    await openSwapUnlock(s.id, s.expiresAt, NOW);
    const l = legs(() => swapUnlocked(s.id, NOW));
    l.move = () => Promise.reject(new Error('the node is busy'));
    await runThorOut(s, l, world('10012000').deps, plan('10012000'));
    expect(await swapUnlocked(s.id, NOW)).toBe(false);
  });

  it('without it the run holds for the person and signs nothing', async () => {
    const s = swap({ moveTxid: 'aa'.repeat(32) });
    const l = legs(() => swapUnlocked(s.id, NOW));
    await runThorOut(s, l, world('0').deps);
    expect(l.calls).toEqual([]);
    expect(runs.getState()[s.id]).toEqual({ at: 'held', moved: true });
  });
});

const ctx = (patch: Partial<LegContext> = {}): LegContext => ({
  storeId: 'vault#1',
  walletId: 'vault',
  pocket: 1,
  zidecarUrl: 'https://z',
  cold: false,
  getVaultUnlock: vi.fn(() => Promise.resolve({ sealTo: vi.fn() })),
  ...patch,
});

const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
};

describe('the second leg picks up after a reopened popup (funds path)', () => {
  it('a moved, funded swap pays the reviewed deposit from its own address, hot', async () => {
    const s = swap({ moveTxid: 'aa'.repeat(32) });
    await openSwapUnlock(s.id, s.expiresAt);
    worker.plan.mockResolvedValue(plan('0'));
    worker.pay.mockResolvedValue({ txid: 'ee'.repeat(32), fee: '12000' });
    const c = ctx();
    runSwapLegs(s, c);
    await settle();
    // the plan reads the swap's own address for the reviewed deposit
    expect(worker.plan).toHaveBeenCalledWith('https://z', {
      tAddress: T.address,
      tIndex: 7,
      to: VAULT,
      amountZat: '10000000',
      memo: MEMO,
      mainnet: true,
      reviewedFee: '12000',
    });
    expect(worker.move).not.toHaveBeenCalled();
    const [store, url, req] = worker.pay.mock.lastCall!;
    expect([store, url]).toEqual(['vault#1', 'https://z']);
    // change and refunds come back to tAddress; the worker refuses any other fee
    expect(req).toMatchObject({ tAddress: T.address, tIndex: 7, to: VAULT, memo: MEMO });
    expect(req).toMatchObject({ amountZat: '10000000', reviewedFee: '12000' });
    expect(c.getVaultUnlock).toHaveBeenCalledWith('vault');
    expect(opens.patch).toHaveBeenCalledWith(s.id, { stage: 'sent', depositTxid: 'ee'.repeat(32) });
  });

  it('a fresh hot swap moves the shortfall from the chosen pocket to the swap address', async () => {
    const s = swap();
    await openSwapUnlock(s.id, s.expiresAt);
    worker.plan.mockResolvedValue(plan('0'));
    worker.move.mockResolvedValue({ txid: 'aa'.repeat(32), fee: '15000' });
    worker.pay.mockResolvedValue({ txid: 'ee'.repeat(32), fee: '12000' });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    runSwapLegs(s, ctx(), plan('10012000'));
    await vi.advanceTimersByTimeAsync(MOVED_POLL_MS + 10);
    vi.useRealTimers();
    await settle();
    const m = worker.move.mock.lastCall!;
    expect([m[0], m[1], m[3], m[4], m[5], m[6], m[7]]).toEqual([
      'zcash',
      'vault#1',
      T.address,
      '10012000',
      '',
      1,
      true,
    ]);
    expect(worker.pay).toHaveBeenCalledTimes(1);
  });

  it('home resumes only a swap whose both legs were reviewed together', () => {
    const state = {} as never;
    // an old record, reviewed by the two-screen flow, has no reviewed deposit fee
    expect(() => resumeSwapLegs(swap({ depositFee: undefined }), state)).not.toThrow();
    expect(worker.plan).not.toHaveBeenCalled();
  });

  it('zigner signs the reviewed deposit bytes from the same request', async () => {
    const s = swap({ moveTxid: 'aa'.repeat(32) });
    worker.plan.mockResolvedValue(plan('0'));
    worker.coldPay.mockResolvedValue({ pcztHex: 'ab', urFrames: ['ur:zigner-module/x'] });
    worker.coldDone.mockResolvedValue({ txid: 'ee'.repeat(32), fee: '12000' });
    runSwapLegs(s, ctx({ cold: true, ufvk: 'uview1x' }));
    await settle();
    const round = swapRound(s.id, 'vault#1');
    expect(round.store.getState().shown?.label).toBe('the swap deposit');
    const req = worker.coldPay.mock.lastCall![2];
    expect(req).toMatchObject({ tAddress: T.address, to: VAULT, memo: MEMO, reviewedFee: '12000' });
    round.cancel();
    await settle();
    expect(runs.getState()[s.id]).toEqual({ at: 'held', moved: true });
    expect(worker.coldDone).not.toHaveBeenCalled();
  });
});
