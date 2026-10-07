import { describe, expect, it, vi } from 'vitest';
import { VAULT_UNPAYABLE } from '../workers/transparent-deposit';
import {
  act,
  ASK_LINE,
  drive,
  OWNER_LINE,
  PAUSED_LINE,
  StaleFlight,
  VAULT_MOVED_LINE,
  type DriveDeps,
} from './drive';
import {
  advance,
  cancelFlight,
  cancellable,
  PAYOUT_BLOCKS,
  sending,
  sent,
  startFlight,
  type Flight,
} from './flight';
import { ADD_MEMO, askZat, withdrawMemo } from './math';

/** THORChain's zec vault on 2026-10-05: a ZIP 320 tex address */
const TEX_VAULT = 'tex1h55z0mdpnaxjxqs39sht9659ztnjk32reer52v';

const inbound = (address = TEX_VAULT) => ({
  address,
  halted: false,
  lpPaused: false,
  dust: 15_000n,
  outboundFee: 44_929n,
});

/**
 * The stored flight, as lp/store.ts saveFlight keeps it: a write lands only
 * over the copy it was made from (same id and rev), or over any rev of the
 * same flight after a broadcast.
 */
const book = () => {
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
  const store = book();
  const d: DriveDeps = {
    owner: 'vault#1',
    address: 't1LpAddressxxxxxxxxxxxxxxxxxxxxxxx',
    index: 21,
    vault: vi.fn(async () => {
      log.push('vault');
      return { inbound: inbound() };
    }),
    plan: vi.fn(async () => ({ fee: '15000', change: '0', short: '1015000' })),
    shieldOut: vi.fn(async () => {
      log.push('shieldOut');
      return 'fund-txid';
    }),
    deposit: vi.fn(async () => {
      log.push('deposit');
      return 'send-txid';
    }),
    shieldBack: vi.fn(async () => 'shield-txid'),
    seen: vi.fn(async () => ({ observed: false, finalised: false })),
    units: vi.fn(async () => 0n),
    utxoZat: vi.fn(async () => []),
    save: vi.fn(async (f: Flight, after?: boolean) => {
      log.push(`save:${f.stage}${f.sending ? ':sending' : ''}`);
      return store.save(f, after);
    }),
    ...over,
  };
  return { d, log, box: store.box };
};

/** a promise the test resolves by hand: a THORNode read that has not answered yet */
const later = <T>() => {
  let resolve!: (v: T) => void;
  const p = new Promise<T>(r => (resolve = r));
  return { p, resolve };
};

const add = () => startFlight('add', 1_000_000n, ADD_MEMO, { unitsBefore: '0' });

describe('refusing before the zec leaves the shielded pool', () => {
  it('stops on a vault zafu cannot pay, and moves nothing', async () => {
    const { d } = deps({ vault: async () => ({ inbound: inbound(`${TEX_VAULT.slice(0, -1)}q`) }) });
    const f = await act(add(), d);
    expect(f.error).toBe(VAULT_UNPAYABLE);
    expect(d.shieldOut).not.toHaveBeenCalled();
    expect(d.plan).not.toHaveBeenCalled();
  });

  it('stops when thorchain has paused adds, and moves nothing', async () => {
    const { d } = deps({ vault: async () => ({ inbound: inbound(), addPaused: 'mimir' }) });
    const f = await act(add(), d);
    expect(f.error).toBe(PAUSED_LINE.add);
    expect(d.shieldOut).not.toHaveBeenCalled();
  });

  it('refuses a memo past 80 bytes before reading anything', async () => {
    const { d } = deps();
    const f = await act(startFlight('add', 1n, 'x'.repeat(81)), d);
    expect(f.error).toMatch(/80 bytes/);
    expect(d.vault).not.toHaveBeenCalled();
  });

  it('a take-out is stopped by a take-out pause, not by an add pause', async () => {
    const out = startFlight('withdraw', 30_000n, withdrawMemo(10_000));
    const addOnly = deps({ vault: async () => ({ inbound: inbound(), addPaused: 'mimir' }) });
    expect((await act(out, addOnly.d)).error).toBeUndefined();
    const both = deps({
      vault: async () => ({ inbound: inbound(), addPaused: 'chain', outPaused: 'chain' }),
    });
    expect((await act(out, both.d)).error).toBe(PAUSED_LINE.withdraw);
  });
});

describe('sending', () => {
  it('saves the sending mark before the shield-out leaves, then the txid', async () => {
    const { d, log } = deps();
    const f = await drive(add(), d, TEX_VAULT);
    expect(log).toEqual(['vault', 'save:fund:sending', 'shieldOut', 'save:settle']);
    expect(f.fundTxid).toBe('fund-txid');
    expect(f.fundZat).toBe('1015000');
    // the deposit it funds rides along, for a wallet that signs both in one round
    expect(d.shieldOut).toHaveBeenCalledWith(
      1_015_000n,
      expect.objectContaining({ memo: ADD_MEMO, amountZat: '1000000' }),
      '15000',
      expect.any(Function),
    );
  });

  it('zigner: the deposit signed with the shield-out is kept on the flight, then sent as is', async () => {
    const held = { txHex: 'signed', expiry: 141, moveTxid: 'fund-txid', moveExpiry: 140 };
    const { d, log, box } = deps({
      shieldOut: vi.fn(async (_zat, _req, _fee, hold) => {
        await hold(held);
        log.push('shieldOut');
        return 'fund-txid';
      }),
    });
    const f = await drive(add(), d, TEX_VAULT);
    // held on the stored flight before the shield-out left
    expect(log).toEqual([
      'vault',
      'save:fund:sending',
      'save:fund:sending',
      'shieldOut',
      'save:settle',
    ]);
    expect(f.held).toEqual(held);
    expect(box.f?.held).toEqual(held);
    const funded = await d.save(advance(f, { short: 0n }));
    const sending = funded.stage === 'send' ? funded : await d.save({ ...funded, stage: 'send' });
    (d.plan as ReturnType<typeof vi.fn>).mockResolvedValue({
      fee: '15000',
      change: '0',
      short: '0',
    });
    const out = await act(sending, d);
    expect(d.deposit).toHaveBeenCalledWith(
      expect.objectContaining({ memo: ADD_MEMO }),
      '15000',
      held,
    );
    expect(out.held).toBeUndefined();
  });

  it('skips the shield-out when the lp address already holds enough', async () => {
    const { d } = deps({ plan: async () => ({ fee: '15000', change: '5', short: '0' }) });
    const f = await act(add(), d);
    expect(f.stage).toBe('send');
    expect(d.shieldOut).not.toHaveBeenCalled();
  });

  it('reads the vault again right before the deposit and pays the fresh one, tex1 included', async () => {
    const rotated = 't1RotatedVaultxxxxxxxxxxxxxxxxxxxx';
    let n = 0;
    const { d } = deps({
      vault: async () => ({ inbound: inbound(n++ ? TEX_VAULT : rotated) }),
      plan: async () => ({ fee: '15000', change: '0', short: '0' }),
    });
    let f = advance(sent(sending(add()), 'fund'), { short: 0n });
    expect(f.stage).toBe('send');
    await d.vault(); // the review's read
    f = await act(f, d);
    expect(f.stage).toBe('seen');
    expect(d.deposit).toHaveBeenCalledWith(
      expect.objectContaining({ to: TEX_VAULT, memo: ADD_MEMO, tIndex: 21, amountZat: '1000000' }),
      '15000',
      undefined,
    );
  });

  it('does not send while the shield-out is still missing coins', async () => {
    const { d } = deps();
    const f = await act(advance(sent(sending(add()), 'fund'), { short: 0n }), d);
    expect(f.error).toMatch(/doesn't hold this yet/);
    expect(d.deposit).not.toHaveBeenCalled();
  });

  it('a failure stops the flight with its line, nothing marked as sending', async () => {
    const { d } = deps({
      shieldOut: async () => {
        throw new Error('the network said no');
      },
    });
    const f = await act(add(), d);
    expect(f.error).toBe('the network said no');
    expect(f.sending).toBeUndefined();
  });
});

describe('watching', () => {
  it('asks thornode only for the stage it is in', async () => {
    const { d } = deps();
    const f = sent(sending(advance(sent(sending(add()), 'f'), { short: 0n })), 'send-txid');
    const next = await drive(f, d, TEX_VAULT);
    expect(d.seen).toHaveBeenCalledWith('send-txid');
    expect(d.units).not.toHaveBeenCalled();
    expect(d.utxoZat).not.toHaveBeenCalled();
    expect(next.stage).toBe('seen');
  });

  it('a withdraw payout lands, then is shielded back on its own', async () => {
    const out = 919_000n;
    const { d } = deps({
      utxoZat: async () => [out],
    });
    let f = startFlight('withdraw', 30_000n, withdrawMemo(10_000));
    f = { ...f, stage: 'arrive', outZat: out.toString(), sendTxid: 'a' };
    f = await drive(f, d, TEX_VAULT);
    expect(f.stage).toBe('shielded');
    expect(f.shieldTxid).toBe('shield-txid');
  });
});

describe('a flight from before this tab', () => {
  it('watches and moves on, but never sends without the person saying continue', async () => {
    const { d } = deps({ plan: async () => ({ fee: '15000', change: '0', short: '0' }) });
    // after the shield-out: the block lands while the tab is reopened
    const f = sent(sending(add()), 'fund');
    const next = await drive(f, d, TEX_VAULT, false);
    expect(next.stage).toBe('send');
    expect(d.deposit).not.toHaveBeenCalled();
    expect(d.vault).not.toHaveBeenCalled();
    // continue: the vault is read fresh, then the deposit leaves
    const after = await drive(next, d, TEX_VAULT, true);
    expect(d.vault).toHaveBeenCalled();
    expect(d.deposit).toHaveBeenCalledTimes(1);
    expect(after.stage).toBe('seen');
  });

  it('does not shield back on its own either', async () => {
    const { d } = deps();
    const f = {
      ...startFlight('withdraw', 30_000n, withdrawMemo(10_000)),
      stage: 'shield' as const,
    };
    expect((await drive(f, d, TEX_VAULT, false)).stage).toBe('shield');
    expect(d.shieldBack).not.toHaveBeenCalled();
  });
});

describe('a cancel made while a turn is running', () => {
  it('wins before the deposit: the turn stops at its sending mark, nothing is broadcast', async () => {
    // the flight sits at settle; the tick's turn is inside observe, waiting on its plan
    const read = later<{ fee: string; change: string; short: string }>();
    let calls = 0;
    const { d, box } = deps({
      plan: async () => (calls++ ? { fee: '15000', change: '0', short: '0' } : read.p),
    });
    const settled = await d.save(sent(sending(add()), 'fund'));
    const turn = drive(settled, d, TEX_VAULT, true);
    // the person cancels and the page writes it to the stored flight, under the lock
    const cancelled = cancelFlight(box.f!)!;
    expect(cancellable(box.f!)).toBe(true);
    box.f = { ...cancelled, rev: (box.f!.rev ?? 0) + 1 };
    // the read lands: short is 0, the turn moves to send and tries to mark it
    read.resolve({ fee: '15000', change: '0', short: '0' });
    await expect(turn).rejects.toBeInstanceOf(StaleFlight);
    expect(d.deposit).not.toHaveBeenCalled();
    expect(box.f!.cancelled).toBe(true);
    expect(box.f!.stage).toBe('shield');
  });

  it('wins inside the send step too: a cancel after the vault read stops the mark', async () => {
    const vault = later<{ inbound: ReturnType<typeof inbound> }>();
    const { d, box } = deps({
      vault: () => vault.p,
      plan: async () => ({ fee: '15000', change: '0', short: '0' }),
    });
    const atSend = await d.save(advance(sent(sending(add()), 'fund'), { short: 0n }));
    const step = act(atSend, d);
    box.f = { ...cancelFlight(box.f!)!, rev: (box.f!.rev ?? 0) + 1 };
    vault.resolve({ inbound: inbound() });
    await expect(step).rejects.toBeInstanceOf(StaleFlight);
    expect(d.deposit).not.toHaveBeenCalled();
    expect(box.f!.cancelled).toBe(true);
  });

  it('cannot cancel a send already marked out: it may be on the network', () => {
    const marked = sending(advance(sent(sending(add()), 'fund'), { short: 0n }));
    expect(cancellable(marked)).toBe(false);
    expect(cancelFlight(marked)).toBe(marked);
  });

  it('a stale copy never overwrites the stored flight', async () => {
    const { d, box } = deps();
    const stored = await d.save(add());
    box.f = { ...stored, rev: 7 };
    await expect(d.save({ ...stored, error: 'old' })).rejects.toBeInstanceOf(StaleFlight);
    expect(box.f.error).toBeUndefined();
  });
});

describe('the vault, pinned to the flight', () => {
  it('pins the first vault it pays toward, and stops if it moves before the deposit', async () => {
    const rotated = 't1PTs8DQifJxg6HmUq7AgYYFNkbyQa1zjgf';
    let n = 0;
    const { d } = deps({
      vault: async () => ({ inbound: inbound(n++ ? rotated : TEX_VAULT) }),
      plan: vi
        .fn()
        .mockResolvedValueOnce({ fee: '15000', change: '0', short: '1015000' })
        .mockResolvedValue({ fee: '15000', change: '0', short: '0' }),
    });
    const funded = await act(add(), d);
    expect(funded.vault).toBe(TEX_VAULT);
    const atSend = await d.save(advance(funded, { short: 0n }));
    const f = await act(atSend, d);
    expect(f.error).toBe(VAULT_MOVED_LINE);
    expect(d.deposit).not.toHaveBeenCalled();
  });
});

describe('the take-out ask', () => {
  it('pays safely above the dust, and never past the cap', () => {
    expect(askZat(15_000n)).toBe(30_000n);
    expect(askZat(15_000n)! > 15_000n).toBe(true);
    expect(askZat(0n)).toBe(10_000n);
    expect(askZat(60_000n)).toBeUndefined();
  });

  it('refuses at send time when the dust read now has moved past the ask', async () => {
    const { d } = deps({ vault: async () => ({ inbound: { ...inbound(), dust: 30_000n } }) });
    const f = await act(startFlight('withdraw', 30_000n, withdrawMemo(10_000)), d);
    expect(f.error).toBe(ASK_LINE);
    expect(d.shieldOut).not.toHaveBeenCalled();
    expect(d.deposit).not.toHaveBeenCalled();
  });
});

describe('the pocket the page is bound to', () => {
  it('never sends a flight of another pocket', async () => {
    const { d } = deps();
    const f = await act({ ...add(), owner: 'vault#2' }, d);
    expect(f.error).toBe(OWNER_LINE);
    expect(d.vault).not.toHaveBeenCalled();
  });

  it('never sends while zafu shows another wallet or pocket', async () => {
    const { d } = deps({ away: () => 'this page is for main pocket · nothing was sent' });
    const f = await act({ ...add(), owner: 'vault#1' }, d);
    expect(f.error).toMatch(/this page is for main pocket/);
    expect(d.shieldOut).not.toHaveBeenCalled();
  });
});

describe('a payout that does not come', () => {
  const asked = () =>
    sent(
      sending({ ...startFlight('withdraw', 30_000n, withdrawMemo(5_000)), stage: 'ask' as const }),
      'ask-txid',
    );

  it('says so after PAYOUT_BLOCKS with nothing planned, and keeps watching', async () => {
    let h = 1000;
    const { d } = deps({ height: () => h });
    let f = await drive(asked(), d, TEX_VAULT);
    expect(f.askHeight).toBe(1000);
    h += PAYOUT_BLOCKS - 1;
    f = await drive(f, d, TEX_VAULT);
    expect(f.late).toBeUndefined();
    h += 1;
    f = await drive(f, d, TEX_VAULT);
    expect(f.late).toBe(true);
    expect(f.stage).toBe('payout');
    // a payout that comes later still moves it on
    const out = { zat: 900_000n, refund: false, txid: 'out' };
    (d.seen as ReturnType<typeof vi.fn>).mockResolvedValue({
      observed: true,
      finalised: true,
      out,
    });
    f = await drive(f, d, TEX_VAULT, false);
    expect(f.stage).toBe('arrive');
    expect(f.late).toBeUndefined();
  });

  it('a planned payout is never called late', () => {
    const f = { ...asked(), askHeight: 1 };
    const planned = { observed: true, finalised: true, out: { zat: 1n, refund: false } };
    expect(advance(f, { seen: planned, height: 1 + PAYOUT_BLOCKS * 3 }).late).toBeUndefined();
  });
});
