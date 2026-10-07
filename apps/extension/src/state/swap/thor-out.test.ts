import { beforeEach, describe, expect, it, vi } from 'vitest';

const worker = vi.hoisted(() => ({
  move: vi.fn(),
  pay: vi.fn(),
  plan: vi.fn(),
  coldMove: vi.fn(),
  coldPay: vi.fn(),
  coldDone: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock('../keyring/network-worker', () => ({
  buildSendTxInWorker: worker.move,
  sendTransparentDepositInWorker: worker.pay,
  planTransparentDepositInWorker: worker.plan,
  buildSendTxPcztInWorker: worker.coldMove,
  buildColdDepositInWorker: worker.coldPay,
  completeColdDepositInWorker: worker.coldDone,
  frostInspectPcztOutputsInWorker: worker.inspect,
  extractSignedPcztTxInWorker: vi.fn(),
  holdColdDepositInWorker: vi.fn(),
  broadcastSignedTxInWorker: vi.fn(),
  lookupTxInWorker: vi.fn(),
  chainTipInWorker: vi.fn(),
  applySignatureContributionsInWorker: vi.fn(),
}));
vi.mock('../../workers/transparent-deposit', async orig => ({
  ...(await orig<object>()),
  checkVault: () => Promise.resolve(),
}));
const thor = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../lp/thor', async orig => ({ ...(await orig<object>()), readVault: thor.read }));
vi.mock('../../net/egress-opt-in', async orig => ({
  ...(await orig<object>()),
  requestEgressOptIn: () => Promise.resolve(),
}));
const opens = vi.hoisted(() => ({ patch: vi.fn(() => Promise.resolve(true)) }));
vi.mock('./open-swaps', async orig => ({ ...(await orig<object>()), patchOpenSwap: opens.patch }));

import {
  MOVED_POLL_MS,
  depositOf,
  nextLeg,
  legsPerUnlock,
  openSwapUnlock,
  runThorOut,
  runs,
  stopThorOut,
  stillPayable,
  takeSwapUnlock,
  type Legs,
  type RunDeps,
} from './thor-out';
import { resumeSwapLegs, runSwapLegs, swapRound, type LegContext } from './thor-legs';
import type { OpenSwap } from './open-swaps';
import { asksCustody } from './routes';
import { ZignerDeclined } from '../../signing/zigner-round';
import type { Held } from '../../signing/move-and-deposit';
import { DISAGREE_LINE } from '../../lp/thor';

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

/** the vault every operator agrees on */
const open = (patch: { address?: string; halted?: boolean; tradingPaused?: boolean } = {}) => ({
  inbound: { address: VAULT, halted: false, tradingPaused: false, ...patch },
});

/** a run's world: plans in order, saves recorded, no real waits */
const world = (...plans: string[]) => {
  const saved: Partial<OpenSwap>[] = [];
  const slept: number[] = [];
  const deps: RunDeps = {
    plan: vi.fn(() => Promise.resolve(plan(plans.length > 1 ? plans.shift()! : plans[0]!))),
    save: p => (saved.push(p), Promise.resolve()),
    mined: () => Promise.resolve(undefined),
    tip: () => Promise.resolve(100),
    sleep: ms => (slept.push(ms), Promise.resolve()),
    now: () => NOW,
    vault: vi.fn(() => Promise.resolve(open())),
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
  thor.read.mockResolvedValue(open());
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

describe('zigner: one round, the deposit held until the move is mined', () => {
  const H: Held = {
    txHex: 'signed-deposit',
    expiry: 141,
    moveTxid: 'aa'.repeat(32),
    moveExpiry: 140,
  };

  /** zigner's legs: the move hands its deposit to hold before it is broadcast */
  const coldish = () => {
    const l = legs();
    l.ready = vi.fn(() => Promise.resolve(true));
    l.move = vi.fn(async (short: string, hold: (h: Held | undefined) => Promise<void>) => {
      await hold(H);
      l.calls.push(`move ${short}`);
      return H.moveTxid;
    });
    l.pay = vi.fn((req, held?: Held) => {
      l.calls.push(held ? `pay held ${held.txHex}` : `pay ${req.amountZat}`);
      return Promise.resolve('ee'.repeat(32));
    });
    return l;
  };

  it('moves, waits for a block, then sends the held deposit with no second ask', async () => {
    const s = swap();
    // the address index lags: the held deposit goes on the move's own block, not on utxos
    const { deps, saved } = world('10012000');
    const mined = [undefined, undefined, 120];
    deps.mined = vi.fn(() => Promise.resolve(mined.shift()));
    deps.tip = () => Promise.resolve(121);
    const seen: string[] = [];
    const off = runs.subscribe(r => seen.push(r[s.id]!.at));
    const l = coldish();
    await runThorOut(s, l, deps, plan('10012000'));
    off();
    expect(l.calls).toEqual(['move 10012000', 'pay held signed-deposit']);
    expect(l.ready).toHaveBeenCalledTimes(1);
    expect(deps.mined).toHaveBeenCalledWith(H.moveTxid);
    // held (sealed, on the record) before the move went out, dropped once sent
    expect(saved[0]).toEqual({ held: H, moveTxid: H.moveTxid });
    expect(saved.at(-1)).toEqual({ stage: 'sent', depositTxid: 'ee'.repeat(32), held: undefined });
    expect([...new Set(seen)]).toEqual(['moving', 'funding', 'paying', 'sent']);
  });

  it('a reopened popup sends the held deposit once the move is mined, signing nothing', async () => {
    const s = swap({ moveTxid: H.moveTxid, held: H });
    const { deps } = world('0');
    deps.mined = () => Promise.resolve(130);
    deps.tip = () => Promise.resolve(131);
    const l = coldish();
    await runThorOut(s, l, deps);
    expect(l.calls).toEqual(['pay held signed-deposit']);
    expect(l.ready).not.toHaveBeenCalled();
  });

  it('a move mined too late for its deposit: the deposit is signed afresh', async () => {
    const s = swap({ moveTxid: H.moveTxid, held: H });
    const { deps, saved } = world('0');
    deps.mined = () => Promise.resolve(141);
    deps.tip = () => Promise.resolve(141);
    const l = coldish();
    await runThorOut(s, l, deps);
    expect(saved[0]).toEqual({ held: undefined });
    expect(l.calls).toEqual(['pay 10000000']);
  });

  it('a move that never reaches a block stops calmly, offering to sign again', async () => {
    const s = swap({ moveTxid: H.moveTxid, held: H });
    const { deps, saved } = world('10012000');
    deps.tip = () => Promise.resolve(150);
    const l = coldish();
    await runThorOut(s, l, deps);
    expect(l.calls).toEqual([]);
    expect(saved).toEqual([{ held: undefined, moveTxid: undefined }]);
    expect(runs.getState()[s.id]).toEqual({ at: 'held', moved: false, late: true });
  });

  it('waits while the move can still land', async () => {
    const s = swap({ moveTxid: H.moveTxid, held: H });
    const { deps, slept } = world('10012000');
    deps.tip = () => Promise.resolve(141);
    deps.sleep = vi.fn(() => (slept.push(1), slept.length > 2 ? stopAll(s.id) : Promise.resolve()));
    const l = coldish();
    await runThorOut(s, l, deps);
    expect(l.calls).toEqual([]);
    expect(runs.getState()[s.id]).toEqual({ at: 'funding', moved: true });
  });
});

const stopAll = (id: string) => (stopThorOut(id), Promise.resolve());

describe('the swap unlock: once for both legs, dropped after', () => {
  const take = (id: string, now = NOW) => takeSwapUnlock(id, now);

  it('covers the move and the deposit, then is gone', async () => {
    const s = swap();
    await openSwapUnlock(s.id, s.expiresAt, legsPerUnlock('grace'), NOW);
    const l = legs(() => take(s.id));
    await runThorOut(s, l, world('10012000', '0').deps, plan('10012000'));
    expect(l.calls).toEqual(['move 10012000', 'pay 10000000']);
    expect(await take(s.id)).toBe(false);
    expect(await chrome.storage.session.get('swapUnlock')).toEqual({});
  });

  it.each(['grace', 'unlock-only'] as const)('%s: one password signs both legs', async level => {
    expect(legsPerUnlock(level)).toBe(2);
    const s = swap();
    await openSwapUnlock(s.id, s.expiresAt, legsPerUnlock(level), NOW);
    const l = legs(() => take(s.id));
    await runThorOut(s, l, world('10012000', '0').deps, plan('10012000'));
    expect(l.calls).toEqual(['move 10012000', 'pay 10000000']);
  });

  it('foilhat: the deposit asks for the password again before it signs', async () => {
    expect(legsPerUnlock('foilhat')).toBe(1);
    const s = swap();
    await openSwapUnlock(s.id, s.expiresAt, legsPerUnlock('foilhat'), NOW);
    const l = legs(() => take(s.id));
    await runThorOut(s, l, world('10012000', '0').deps, plan('10012000'));
    // the move went out under the confirm's password; the deposit holds for another
    expect(l.calls).toEqual(['move 10012000']);
    expect(runs.getState()[s.id]).toEqual({ at: 'held', moved: true });
    // the second password opens one more leg: the deposit, and nothing after it
    await openSwapUnlock(s.id, s.expiresAt, legsPerUnlock('foilhat'), NOW);
    await runThorOut({ ...s, moveTxid: 'aa'.repeat(32) }, l, world('0').deps);
    expect(l.calls).toEqual(['move 10012000', 'pay 10000000']);
    expect(await take(s.id)).toBe(false);
  });

  it('is this swap only, and no longer than its price or the grace window', async () => {
    const s = swap({ expiresAt: NOW + 5 * 60_000 });
    await openSwapUnlock(s.id, s.expiresAt, 2, NOW);
    expect(await take('another swap')).toBe(false);
    expect(await take(s.id, NOW + 5 * 60_000)).toBe(false);
    expect(await take(s.id)).toBe(true);
    await openSwapUnlock(s.id, undefined, 2, NOW);
    expect(await take(s.id, NOW + 15 * 60_000)).toBe(false);
  });

  it('a stopped swap drops it too', async () => {
    const s = swap();
    await openSwapUnlock(s.id, s.expiresAt, 2, NOW);
    const l = legs(() => take(s.id));
    l.move = () => Promise.reject(new Error('the node is busy'));
    await runThorOut(s, l, world('10012000').deps, plan('10012000'));
    expect(await chrome.storage.session.get('swapUnlock')).toEqual({});
  });

  it('without it the run holds for the person and signs nothing', async () => {
    const s = swap({ moveTxid: 'aa'.repeat(32) });
    const l = legs(() => take(s.id));
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
  legsPerUnlock: 2,
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
    await openSwapUnlock(s.id, s.expiresAt, 2);
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
    await openSwapUnlock(s.id, s.expiresAt, 2);
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

describe('a fresh zigner swap asks once', () => {
  it('one batch round carrying the move and the deposit that spends it', async () => {
    const s = swap();
    worker.plan.mockResolvedValue(plan('10012000'));
    worker.coldMove.mockResolvedValue({
      pcztHex: 'aa',
      cborData: Uint8Array.of(0x53, 0x04, 0x03, 0xbe, 0xef),
      coldSendId: 'c1',
    });
    worker.inspect.mockResolvedValue({
      computed_sighash_hex: 'cd'.repeat(32),
      transparent_input_count: 0,
      transparent_outputs: [{ value_zat: 10012000, script_pubkey_hex: '76a9', address: T.address }],
      expiry_height: 140,
    });
    worker.coldPay.mockResolvedValue({ pcztHex: 'dd', urFrames: ['ur:zigner-module/x'] });
    runSwapLegs(s, ctx({ cold: true, ufvk: 'uview1x' }), plan('10012000'));
    await settle();
    const round = swapRound(s.id, 'vault#1');
    expect(round.store.getState().shown?.label).toBe('sign once · the move and the swap');
    // the deposit spends the unsigned move's coin and rides the same request
    const [, , req, ufvk, pair] = worker.coldPay.mock.lastCall!;
    expect(req).toMatchObject({ tAddress: T.address, to: VAULT, memo: MEMO, reviewedFee: '12000' });
    expect(ufvk).toBe('uview1x');
    expect(pair).toEqual({
      coin: { txid: 'cd'.repeat(32), vout: 0, value: '10012000', script: '76a9', expiry: 140 },
      movePcztHex: 'beef',
    });
    round.cancel();
    await settle();
    expect(runs.getState()[s.id]).toEqual({ at: 'held', moved: false });
    expect(worker.coldDone).not.toHaveBeenCalled();
  });
});

describe('the vault is read again before any leg signs', () => {
  const stoppedWith = (id: string) => (runs.getState()[id] as { error?: string }).error;

  it('reads it before the move and again before the deposit, and goes on when it holds', async () => {
    const s = swap();
    const { deps } = world('10012000', '0');
    const l = legs();
    await runThorOut(s, l, deps, plan('10012000'));
    expect(l.calls).toEqual(['move 10012000', 'pay 10000000']);
    expect(deps.vault).toHaveBeenCalledTimes(2);
  });

  it('a vault that changed since the quote: refused before anything signs', async () => {
    const s = swap();
    const { deps } = world('10012000');
    deps.vault = () => Promise.resolve(open({ address: 't1AnotherVaultzzzzzzzzzzzzzzzzzzzz' }));
    const l = legs();
    await runThorOut(s, l, deps, plan('10012000'));
    expect(l.calls).toEqual([]);
    expect(runs.getState()[s.id]).toMatchObject({ at: 'stopped', moved: false });
    expect(stoppedWith(s.id)).toBe(
      "the swap's vault changed · please get a new quote, nothing was sent",
    );
  });

  it('after the move, a changed vault stops the deposit and says the zec is still here', async () => {
    const s = swap({ moveTxid: 'aa'.repeat(32) });
    const { deps } = world('0');
    deps.vault = () => Promise.resolve(open({ address: 't1AnotherVaultzzzzzzzzzzzzzzzzzzzz' }));
    const l = legs();
    await runThorOut(s, l, deps);
    expect(l.calls).toEqual([]);
    expect(stoppedWith(s.id)).toMatch(/vault changed .* nothing went to the vault/);
  });

  it.each([{ halted: true }, { tradingPaused: true }])('%o: refused', async patch => {
    const s = swap({ moveTxid: 'aa'.repeat(32) });
    const { deps } = world('0');
    deps.vault = () => Promise.resolve(open(patch));
    const l = legs();
    await runThorOut(s, l, deps);
    expect(l.calls).toEqual([]);
    expect(stoppedWith(s.id)).toBe(
      "thorchain isn't taking zec right now · nothing went to the vault",
    );
  });

  it('operators that disagree: refused, nothing signed', async () => {
    const s = swap();
    const { deps } = world('10012000');
    deps.vault = () => Promise.reject(new Error(DISAGREE_LINE));
    const l = legs();
    await runThorOut(s, l, deps, plan('10012000'));
    expect(l.calls).toEqual([]);
    expect(stoppedWith(s.id)).toBe(DISAGREE_LINE);
  });

  it('the vault the quote named, open and agreed, passes', () => {
    expect(() => stillPayable(open(), VAULT, 'pay')).not.toThrow();
  });

  it('hot: the wired run asks every operator and pays nothing to a changed vault', async () => {
    const s = swap({ moveTxid: 'aa'.repeat(32) });
    await openSwapUnlock(s.id, s.expiresAt, 2);
    worker.plan.mockResolvedValue(plan('0'));
    thor.read.mockResolvedValue(open({ address: 't1AnotherVaultzzzzzzzzzzzzzzzzzzzz' }));
    runSwapLegs(s, ctx());
    await settle();
    expect(thor.read).toHaveBeenCalled();
    expect(worker.pay).not.toHaveBeenCalled();
    expect(stoppedWith(s.id)).toMatch(/vault changed/);
  });

  it('zigner: the one round (move and deposit) is never built toward a changed vault', async () => {
    const s = swap();
    worker.plan.mockResolvedValue(plan('10012000'));
    thor.read.mockResolvedValue(open({ address: 't1AnotherVaultzzzzzzzzzzzzzzzzzzzz' }));
    runSwapLegs(s, ctx({ cold: true, ufvk: 'uview1x' }), plan('10012000'));
    await settle();
    expect(worker.coldMove).not.toHaveBeenCalled();
    expect(worker.coldPay).not.toHaveBeenCalled();
    expect(stoppedWith(s.id)).toBe(
      "the swap's vault changed · please get a new quote, nothing was sent",
    );
  });

  it('zigner: a held deposit is not broadcast when the operators disagree', async () => {
    const H: Held = { txHex: 'signed', expiry: 141, moveTxid: 'aa'.repeat(32), moveExpiry: 140 };
    const s = swap({ moveTxid: H.moveTxid, held: H });
    worker.plan.mockResolvedValue(plan('0'));
    const nw = await import('../keyring/network-worker');
    vi.mocked(nw.lookupTxInWorker).mockResolvedValue({ height: 120 } as never);
    vi.mocked(nw.chainTipInWorker).mockResolvedValue(121 as never);
    thor.read.mockRejectedValue(new Error(DISAGREE_LINE));
    runSwapLegs(s, ctx({ cold: true, ufvk: 'uview1x' }));
    await settle();
    expect(worker.coldDone).not.toHaveBeenCalled();
    expect(stoppedWith(s.id)).toBe(DISAGREE_LINE);
  });
});

describe('custody is acknowledged once per provider', () => {
  it('near (a solver holds funds) asks on the first swap only; thorchain never asks', () => {
    expect(asksCustody('near', [])).toBe(true);
    expect(asksCustody('near', ['near'])).toBe(false);
    expect(asksCustody('thor', [])).toBe(false);
  });
});
