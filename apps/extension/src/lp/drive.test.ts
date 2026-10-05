import { describe, expect, it, vi } from 'vitest';
import { VAULT_UNPAYABLE } from '../workers/transparent-deposit';
import { act, drive, PAUSED_LINE, type DriveDeps } from './drive';
import { advance, sending, sent, startFlight, type Flight } from './flight';
import { ADD_MEMO, withdrawMemo } from './math';

/** THORChain's zec vault on 2026-10-05: a ZIP 320 tex address */
const TEX_VAULT = 'tex1h55z0mdpnaxjxqs39sht9659ztnjk32reer52v';

const inbound = (address = TEX_VAULT) => ({
  address,
  halted: false,
  lpPaused: false,
  dust: 15_000n,
  outboundFee: 44_929n,
});

const deps = (over: Partial<DriveDeps> = {}) => {
  const log: string[] = [];
  const d: DriveDeps = {
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
    save: vi.fn(async (f: Flight) => log.push(`save:${f.stage}${f.sending ? ':sending' : ''}`)),
    ...over,
  };
  return { d, log };
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
    const out = startFlight('withdraw', 15_000n, withdrawMemo(10_000));
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
    expect(d.shieldOut).toHaveBeenCalledWith(1_015_000n);
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
    let f = startFlight('withdraw', 15_000n, withdrawMemo(10_000));
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
      ...startFlight('withdraw', 15_000n, withdrawMemo(10_000)),
      stage: 'shield' as const,
    };
    expect((await drive(f, d, TEX_VAULT, false)).stage).toBe('shield');
    expect(d.shieldBack).not.toHaveBeenCalled();
  });
});
