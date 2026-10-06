import { describe, expect, it, vi } from 'vitest';
import { act, drive, PAUSED_LINE, StaleFlight, type DriveDeps } from './drive';
import {
  advance,
  cancelFlight,
  cancellable,
  isDone,
  isFlight,
  HALF_BLOCKS,
  LOST_LINE,
  needs,
  recoverHalf,
  resumed,
  sending,
  sent,
  shieldRefund,
  startFlight,
  stepLines,
  type Flight,
} from './flight';
import {
  memoFits,
  offRatioPct,
  pairedAddMemo,
  pairedWithdraw,
  pairedWithdrawMemo,
  quotePaired,
  RECOVER_MEMO,
  runeFor,
  runeText,
  withdrawZec,
  zecText,
} from './math';

const THOR1 = 'thor1zf3gsk7edzwl9syyefvfhle37cjtql35nd8hd7';
const LP = 't1SS4bxPM3ogU4USyHvzheVQDWa7Gbztz4p';
const T = {
  zec: zecText,
  rune: runeText,
  address: 't1SS4…z4p',
  thor: 'thor1…hd7',
  pocket: 'main pocket',
};
const POOL = { asset: 2_349_956_151n, rune: 4_115_368_117_505n, units: 3_902_179_720_724n };

const add2 = (extra: Partial<Flight> = {}) =>
  startFlight(
    'add2',
    1_000_000n,
    pairedAddMemo(THOR1),
    {
      thor: THOR1,
      runeBase: runeFor(POOL, 1_000_000n).toString(),
      unitsBefore: '0',
      ...extra,
    },
    1000,
  );

describe('two-sided memos, as THORNode parses them', () => {
  it('each half names the other address; the zec one fits an OP_RETURN', () => {
    expect(pairedAddMemo(THOR1)).toBe(`+:ZEC.ZEC:${THOR1}`);
    expect(pairedAddMemo(LP)).toBe(`+:ZEC.ZEC:${LP}`);
    // a mainnet rune half on this pool carried exactly this shape (tx DA2D99E9...)
    expect(pairedAddMemo(LP)).toBe('+:ZEC.ZEC:t1SS4bxPM3ogU4USyHvzheVQDWa7Gbztz4p');
    expect(memoFits(pairedAddMemo(THOR1))).toBe(true);
  });

  it('a take-out from the thor1: both sides, all as zec, or all as rune', () => {
    expect(pairedWithdrawMemo(10_000)).toBe('-:ZEC.ZEC:10000');
    expect(pairedWithdrawMemo(5_000, 'zec')).toBe('-:ZEC.ZEC:5000:ZEC.ZEC');
    expect(pairedWithdrawMemo(2_500, 'rune')).toBe('-:ZEC.ZEC:2500:THOR.RUNE');
    expect(RECOVER_MEMO).toBe('-:ZEC.ZEC:10000');
    expect(() => pairedWithdrawMemo(0)).toThrow();
  });
});

describe('two-sided amounts', () => {
  it('the rune half is the pool ratio, and a balanced pair costs about nothing', () => {
    const rune = runeFor(POOL, 1_000_000n);
    expect(rune).toBe((1_000_000n * POOL.rune) / POOL.asset);
    expect(Math.abs(offRatioPct(POOL, 1_000_000n, rune))).toBeLessThan(0.001);
    const q = quotePaired(POOL, 1_000_000n, rune, {
      zec: 100,
      rune: (100 * Number(POOL.asset)) / Number(POOL.rune),
    });
    expect(q!.costPct!).toBeLessThan(0.01);
    expect(q!.costPct!).toBeGreaterThan(-0.01);
    // off the ratio by 10%: said, and it costs
    expect(offRatioPct(POOL, 1_000_000n, (rune * 11n) / 10n)).toBeCloseTo(10, 1);
  });

  it('a take-out pays both shares, or swaps one side into the other', () => {
    const units = 1_000_000_000n;
    const both = pairedWithdraw(POOL, units, 10_000, 10n, 'both');
    expect(both.zat).toBe((units * POOL.asset) / POOL.units);
    expect(both.rune).toBe((units * POOL.rune) / POOL.units);
    const zec = pairedWithdraw(POOL, units, 10_000, 10n, 'zec');
    expect(zec.rune).toBe(0n);
    expect(zec.zat).toBe(withdrawZec(POOL, units, 10_000, 10n));
    expect(zec.zat).toBeGreaterThan(both.zat);
    const rune = pairedWithdraw(POOL, units, 10_000, 10n, 'rune');
    expect(rune.zat).toBe(0n);
    expect(rune.rune).toBeGreaterThan(both.rune);
  });
});

describe('a two-sided add in flight', () => {
  it('the rune half goes first and waits; only then the zec half', () => {
    let f = add2();
    expect(needs(f)).toBe('fund');
    f = sent(sending(f), 'fund-tx');
    f = advance(f, { short: 0n });
    expect(f.stage).toBe('rune');
    expect(needs(f)).toBe('rune');
    f = sent(sending(f), 'RUNETX');
    expect(f.stage).toBe('half');
    expect(f.runeTxid).toBe('RUNETX');
    expect(needs(f)).toBeUndefined();
    // not seen waiting yet: nothing moves, the zec half does not go
    expect(advance(f, { paired: { units: 0n, pendingRune: 0n, pendingAsset: 0n } })).toBe(f);
    const lines = stepLines(f, T);
    expect(lines.find(l => l.state === 'now')?.t).toBe('waiting for the other side');
    f = advance(f, { paired: { units: 0n, pendingRune: BigInt(f.runeBase!), pendingAsset: 0n } });
    expect(f.stage).toBe('send');
    expect(needs(f)).toBe('send');
    f = sent(sending(f), 'zec-tx');
    f = advance(f, { seen: { observed: true, finalised: false } });
    expect(f.stage).toBe('credit');
    // finalised, units still 0 under the thor1: waiting
    expect(
      advance(f, {
        seen: { observed: true, finalised: true },
        paired: { units: 0n, pendingRune: 1n, pendingAsset: 0n },
      }).stage,
    ).toBe('credit');
    f = advance(f, {
      seen: { observed: true, finalised: true },
      paired: { units: 5_000n, pendingRune: 0n, pendingAsset: 0n },
    });
    expect(f.stage).toBe('credited');
    expect(isDone(f)).toBe(true);
  });

  it('half arrived: the zec half came back, the rune waits; taking it back, then shielding the zec', () => {
    let f = add2({ runeBase: '99' });
    f = advance(sent(sending(f), 'fund'), { short: 0n });
    f = sent(sending(f), 'RUNETX');
    f = advance(f, { paired: { units: 0n, pendingRune: 99n, pendingAsset: 0n } });
    f = sent(sending(f), 'zec-tx');
    f = advance(f, {
      seen: { observed: true, finalised: true, out: { zat: 950_000n, refund: true, txid: 'back' } },
      refundReason: 'adds were paused',
    });
    expect(f.stage).toBe('refunded');
    expect(f.outZat).toBe('950000');
    expect(stepLines(f, T).map(l => l.t)).toEqual(
      expect.arrayContaining(['thorchain returned the zec half', 'rune half taken back']),
    );
    f = recoverHalf(f);
    expect(f.stage).toBe('recover');
    expect(needs(f)).toBe('recover');
    f = sent(sending(f), 'RECOVERTX');
    expect(f.stage).toBe('recovering');
    expect(f.recoverTxid).toBe('RECOVERTX');
    // still pending: waiting
    expect(advance(f, { paired: { units: 0n, pendingRune: 99n, pendingAsset: 0n } })).toBe(f);
    f = advance(f, { paired: { units: 0n, pendingRune: 0n, pendingAsset: 0n } });
    expect(f.stage).toBe('shield');
    expect(needs(f)).toBe('shield');
    f = sent(sending(f), 'shield-tx');
    expect(f.stage).toBe('shielded');
  });

  it('a waiting rune half can be cancelled: taken back, then the zec shielded', () => {
    let f = add2();
    f = advance(sent(sending(f), 'fund'), { short: 0n });
    f = sent(sending(f), 'RUNETX');
    expect(cancellable(f)).toBe(true);
    f = cancelFlight(f)!;
    expect(f.stage).toBe('recover');
    expect(f.cancelled).toBe(true);
    f = advance(sent(sending(f), 'REC'), {
      paired: { units: 0n, pendingRune: 0n, pendingAsset: 0n },
    });
    expect(f.stage).toBe('shield');
    expect(stepLines(f, T)[3]?.t).toBe('cancelled · the zec half was not sent');
  });

  it('once the zec half is out it can no longer be cancelled', () => {
    let f = add2();
    f = advance(sent(sending(f), 'fund'), { short: 0n });
    f = sent(sending(f), 'RUNETX');
    f = advance(f, { paired: { units: 0n, pendingRune: BigInt(f.runeBase!), pendingAsset: 0n } });
    f = sent(sending(f), 'zec-tx');
    expect(cancellable(f)).toBe(false);
    expect(cancelFlight(f)).toBe(f);
  });

  it('a rune half marked out when the tab closed is never sent again by itself', () => {
    let f = add2();
    f = advance(sent(sending(f), 'fund'), { short: 0n });
    const back = resumed(JSON.parse(JSON.stringify(sending(f))) as Flight);
    expect(needs(back)).toBeUndefined();
    expect(back.error).toMatch(/may already have gone out/);
  });

  it('a stored two-sided flight keeps its shape; one without its thor1 is dropped', () => {
    const f = add2();
    expect(isFlight(JSON.parse(JSON.stringify(f)))).toBe(true);
    expect(isFlight({ ...f, thor: undefined })).toBe(false);
  });
});

describe('a waiting half taken back from the position', () => {
  it('lists only what this page does: the take-back, then the shield', () => {
    let f = startFlight('add2', 0n, RECOVER_MEMO, {
      thor: THOR1,
      stage: 'recover',
      runeTxid: 'PENDING',
      outZat: '50000',
    });
    expect(needs(f)).toBe('recover');
    expect(stepLines(f, T).map(l => l.t)).toEqual(['waiting half taken back']);
    f = advance(sent(sending(f), 'REC'), {
      paired: { units: 0n, pendingRune: 0n, pendingAsset: 0n },
    });
    expect(f.stage).toBe('shield');
    expect(stepLines(f, T).map(l => l.t)).toEqual([
      'waiting half taken back',
      'shielded back to main pocket',
    ]);
  });
});

describe('a two-sided take-out in flight', () => {
  const out = (as: 'both' | 'zec' | 'rune') =>
    startFlight('withdraw2', 0n, pairedWithdrawMemo(10_000, as), {
      thor: THOR1,
      payoutAs: as,
      stage: 'ask',
      unitsBefore: '5000',
      expectZat: '900000',
      expectRune: '17000000',
    });

  it('is asked from the thor1 (a rune MsgDeposit), and the zec lands and is shielded', () => {
    let f = out('both');
    expect(needs(f)).toBe('rune');
    f = sent(sending(f), 'ASKTX');
    expect(f.stage).toBe('payout');
    expect(f.runeTxid).toBe('ASKTX');
    f = advance(f, {
      seen: { observed: true, finalised: true, out: { zat: 880_000n, refund: false, txid: 'pay' } },
    });
    expect(f.stage).toBe('arrive');
    f = advance(f, { utxoZat: [880_000n] });
    expect(f.stage).toBe('shield');
  });

  it('paid all in rune: done once the units drop, nothing to shield', () => {
    let f = sent(sending(out('rune')), 'ASKTX');
    expect(
      advance(f, {
        seen: { observed: true, finalised: true },
        paired: { units: 5_000n, pendingRune: 0n, pendingAsset: 0n },
      }).stage,
    ).toBe('payout');
    f = advance(f, {
      seen: { observed: true, finalised: true },
      paired: { units: 0n, pendingRune: 0n, pendingAsset: 0n },
    });
    expect(f.stage).toBe('received');
    expect(isDone(f)).toBe(true);
  });

  it('is never cancellable: nothing to shield back', () => {
    expect(cancellable(out('both'))).toBe(false);
  });
});

/** the stored flight, compare-and-set like lp/store.ts saveFlight */
const store = () => {
  const box: { f?: Flight } = {};
  const save = async (f: Flight, after = false): Promise<Flight> => {
    const cur = box.f;
    if (cur && (cur.id !== f.id || (!after && (cur.rev ?? 0) !== (f.rev ?? 0)))) {
      throw new StaleFlight();
    }
    box.f = { ...f, rev: (cur?.rev ?? 0) + 1 };
    return box.f;
  };
  return { box, save };
};

const deps = (over: Partial<DriveDeps> = {}) => {
  const log: string[] = [];
  const s = store();
  const d: DriveDeps = {
    owner: 'vault#1',
    address: LP,
    index: 21,
    vault: vi.fn(async () => ({
      inbound: {
        address: 'tex1h55z0mdpnaxjxqs39sht9659ztnjk32reer52v',
        halted: false,
        lpPaused: false,
        dust: 15_000n,
        outboundFee: 44_929n,
      },
    })),
    plan: vi.fn(async () => ({ fee: '15000', change: '0', short: '0' })),
    shieldOut: vi.fn(async () => 'fund-txid'),
    deposit: vi.fn(async () => {
      log.push('zec-deposit');
      return 'zec-txid';
    }),
    shieldBack: vi.fn(async () => 'shield-txid'),
    seen: vi.fn(async () => ({ observed: false, finalised: false })),
    units: vi.fn(async () => 0n),
    utxoZat: vi.fn(async () => []),
    runeSend: vi.fn(async (memo: string, rune: bigint) => {
      log.push(`rune:${memo}:${rune}`);
      return 'RUNE-TX';
    }),
    paired: vi.fn(async () => undefined),
    save: vi.fn(async (f: Flight, after?: boolean) => s.save(f, after)),
    ...over,
  };
  return { d, log, box: s.box };
};

describe('driving a two-sided add', () => {
  it('sends the rune half naming the lp address, then waits for it before any zec goes', async () => {
    const { d, log } = deps();
    let f = await act(add2(), d); // fund: the lp address already holds it
    expect(f.stage).toBe('rune');
    f = await act(f, d);
    expect(log).toEqual([`rune:+:ZEC.ZEC:${LP}:${runeFor(POOL, 1_000_000n)}`]);
    expect(f.stage).toBe('half');
    // THORNode does not show it waiting yet: no zec deposit
    f = await drive(f, d, 'vault');
    expect(f.stage).toBe('half');
    expect(d.deposit).not.toHaveBeenCalled();
    // now it does: the zec half goes, with the thor1 in its memo
    (d.paired as ReturnType<typeof vi.fn>).mockResolvedValue({
      units: 0n,
      pendingRune: BigInt(f.runeBase!),
      pendingAsset: 0n,
    });
    f = await drive(f, d, 'vault');
    expect(f.stage).toBe('seen');
    expect(d.deposit).toHaveBeenCalledWith(
      expect.objectContaining({ memo: `+:ZEC.ZEC:${THOR1}` }),
      '15000',
    );
  });

  it('a pause stops the rune half before it is signed', async () => {
    const { d } = deps({
      vault: async () => ({
        inbound: {
          address: 'tex1h55z0mdpnaxjxqs39sht9659ztnjk32reer52v',
          halted: false,
          lpPaused: false,
          dust: 1n,
          outboundFee: 1n,
        },
        addPaused: 'mimir',
      }),
    });
    const f = await act({ ...add2(), stage: 'rune' }, d);
    expect(f.error).toBe(PAUSED_LINE.add);
    expect(d.runeSend).not.toHaveBeenCalled();
  });

  it('a rune refusal (simulate said no) stops with its line, nothing marked out', async () => {
    const { d } = deps({
      runeSend: vi.fn(async () => {
        throw new Error('thorchain would not take this: insufficient funds · nothing was sent');
      }),
    });
    const f = await act({ ...add2(), stage: 'rune' }, d);
    expect(f.error).toMatch(/insufficient funds/);
    expect(f.runeTxid).toBeUndefined();
  });

  it('the take-back sends the recover memo with 0 rune', async () => {
    const { d, log } = deps();
    await act({ ...add2(), stage: 'recover', runeTxid: 'R' }, d);
    expect(log).toEqual(['rune:-:ZEC.ZEC:10000:0']);
  });

  it('a pocket without the rune opt-in never sends a rune half', async () => {
    const { d } = deps({ runeSend: undefined });
    const f = await act({ ...add2(), stage: 'rune' }, d);
    expect(f.error).toMatch(/does not use rune/);
  });
});

describe('a rune half that never shows as waiting', () => {
  const atHalf = () => ({
    ...add2(),
    stage: 'half' as const,
    runeTxid: 'RUNETX',
    fundTxid: 'fund',
  });
  const none = { units: 0n, pendingRune: 0n, pendingAsset: 0n };

  it('the zec half is never sent while the rune half is not seen waiting, however long', async () => {
    let h = 28_000_000;
    const runeTx = vi.fn(async () => ({ state: 'included' as const }));
    const { d } = deps({ height: () => h, runeTx, paired: vi.fn(async () => none) });
    let f: Flight = atHalf();
    for (let i = 0; i < 12; i++) {
      f = await drive(f, d, 'vault');
      h += 30;
    }
    expect(f.stage).toBe('half');
    expect(f.halfHeight).toBe(28_000_000);
    // past the deadline it was looked up: included, so still watched
    expect(runeTx).toHaveBeenCalledWith('RUNETX');
    expect(d.deposit).not.toHaveBeenCalled();
    expect(d.shieldOut).not.toHaveBeenCalled();
  });

  it('not looked up before the deadline', async () => {
    let h = 100;
    const runeTx = vi.fn(async () => ({ state: 'missing' as const }));
    const { d } = deps({ height: () => h, runeTx, paired: vi.fn(async () => none) });
    let f: Flight = await drive(atHalf(), d, 'vault');
    h += HALF_BLOCKS - 1;
    f = await drive(f, d, 'vault');
    expect(runeTx).not.toHaveBeenCalled();
    expect(f.stage).toBe('half');
  });

  it('past the deadline and nowhere on chain: lost, calmly, nothing added', async () => {
    let h = 100;
    const { d } = deps({
      height: () => h,
      runeTx: vi.fn(async () => ({ state: 'missing' as const })),
      paired: vi.fn(async () => none),
    });
    let f: Flight = await drive(atHalf(), d, 'vault');
    h += HALF_BLOCKS;
    f = await drive(f, d, 'vault');
    expect(f.stage).toBe('lost');
    expect(isDone(f)).toBe(true);
    expect(d.deposit).not.toHaveBeenCalled();
    expect(LOST_LINE).toBe(
      "the rune half didn't arrive · nothing was added · your rune is still in your rune address",
    );
    expect(stepLines(f, T).map(l => l.t)).toContain("the rune half didn't arrive");
    // stop: the zec at the lp address is shielded back
    f = shieldRefund(f);
    expect(f.stage).toBe('shield');
    expect(needs(f)).toBe('shield');
  });

  it('refused on chain: lost, with its log as the reason', () => {
    const f = advance(
      { ...atHalf(), halfHeight: 1 },
      { paired: none, height: 500, runeTx: { state: 'failed', log: 'insufficient funds' } },
    );
    expect(f.stage).toBe('lost');
    expect(f.reason).toBe('insufficient funds');
  });

  it('landed late: it shows waiting on a later read, and the zec half goes then', async () => {
    let h = 100;
    const paired = vi.fn(async () => none as typeof none);
    const { d } = deps({
      height: () => h,
      runeTx: vi.fn(async () => ({ state: 'included' as const })),
      paired,
    });
    let f: Flight = await drive(atHalf(), d, 'vault');
    h += HALF_BLOCKS + 5;
    f = await drive(f, d, 'vault');
    expect(f.stage).toBe('half');
    paired.mockResolvedValue({ units: 0n, pendingRune: BigInt(f.runeBase!), pendingAsset: 0n });
    f = await drive(f, d, 'vault');
    expect(f.stage).toBe('seen');
    expect(d.deposit).toHaveBeenCalledTimes(1);
  });
});
