import { describe, expect, it, vi } from 'vitest';
import { heldNext, moveAndDeposit, type Held, type PairDeps } from './move-and-deposit';
import { MOVE_MISMATCH } from '../workers/transparent-deposit';

const T = 't1SwapOwnAddressxxxxxxxxxxxxxxxxx';
const WIRE = 'ab'.repeat(31) + 'cd';
const TXID = 'cd' + 'ab'.repeat(31);
/** a V5 deposit spending (TXID, 0): header, one input, no outputs */
const DEPOSIT = `${'00'.repeat(20)}01${WIRE}00000000${'00'}ffffffff00`;

const deps = (patch: Partial<PairDeps> = {}) => {
  const calls: string[] = [];
  const d: PairDeps = {
    buildMove: vi.fn(() =>
      Promise.resolve({
        pcztHex: 'aa',
        cborData: Uint8Array.of(0x53, 0x04, 0x03, 0xbe, 0xef),
        coldSendId: 'c1',
      }),
    ),
    inspect: vi.fn(() =>
      Promise.resolve({
        computed_sighash_hex: WIRE,
        transparent_input_count: 0,
        transparent_outputs: [{ value_zat: 425_000, script_pubkey_hex: '76a9', address: T }],
        expiry_height: 140,
      }),
    ),
    buildDeposit: vi.fn((_coin, move: string) => {
      calls.push(`deposit after ${move}`);
      return Promise.resolve({ pcztHex: 'dd', urFrames: [] });
    }),
    sign: vi.fn(() => (calls.push('sign'), Promise.resolve(['m', 'd']))),
    finishDeposit: vi.fn(() => Promise.resolve({ txHex: DEPOSIT, expiry: 141 })),
    extract: vi.fn(() => Promise.resolve({ txHex: 'move-tx', txid: TXID })),
    hold: vi.fn((h: Held | undefined) => (calls.push(h ? 'hold' : 'let go'), Promise.resolve())),
    broadcastMove: vi.fn(() => (calls.push('move'), Promise.resolve(TXID))),
    ...patch,
  };
  return { d, calls };
};

describe('the move and its deposit, one round', () => {
  it('signs both, holds the deposit, then sends the move', async () => {
    const { d, calls } = deps();
    expect(await moveAndDeposit(d, T, '425000')).toBe(TXID);
    expect(calls).toEqual(['deposit after beef', 'sign', 'hold', 'move']);
    expect(d.buildDeposit).toHaveBeenCalledWith(
      { txid: TXID, vout: 0, value: '425000', script: '76a9', expiry: 140 },
      'beef',
    );
    expect(d.hold).toHaveBeenCalledWith({
      txHex: DEPOSIT,
      expiry: 141,
      moveTxid: TXID,
      moveExpiry: 140,
    });
    expect(d.broadcastMove).toHaveBeenCalledWith('move-tx', 'c1');
  });

  it('a move that does not fund the swap as reviewed is never signed', async () => {
    const { d } = deps({
      inspect: () =>
        Promise.resolve({
          computed_sighash_hex: WIRE,
          transparent_input_count: 0,
          transparent_outputs: [{ value_zat: 1, script_pubkey_hex: '76a9', address: T }],
          expiry_height: 140,
        }),
    });
    await expect(moveAndDeposit(d, T, '425000')).rejects.toThrow(MOVE_MISMATCH);
    expect(d.sign).not.toHaveBeenCalled();
  });

  it('a signed move with another txid, or a deposit spending elsewhere, sends nothing', async () => {
    for (const patch of [
      { extract: () => Promise.resolve({ txHex: 'x', txid: 'ff'.repeat(32) }) },
      {
        finishDeposit: () =>
          Promise.resolve({ txHex: DEPOSIT.replace(WIRE, 'ee'.repeat(32)), expiry: 1 }),
      },
    ]) {
      const { d } = deps(patch);
      await expect(moveAndDeposit(d, T, '425000')).rejects.toThrow(MOVE_MISMATCH);
      expect(d.hold).not.toHaveBeenCalled();
      expect(d.broadcastMove).not.toHaveBeenCalled();
    }
  });

  it('a deposit that fails its check holds nothing and sends nothing', async () => {
    const { d } = deps({
      finishDeposit: () =>
        Promise.reject(new Error('the signed deposit does not match your review')),
    });
    await expect(moveAndDeposit(d, T, '425000')).rejects.toThrow(/review/);
    expect(d.hold).not.toHaveBeenCalled();
    expect(d.broadcastMove).not.toHaveBeenCalled();
  });

  it('a move the node refuses lets the held deposit go; an unknown outcome keeps it', async () => {
    const refused = deps({
      broadcastMove: () => Promise.reject(new Error('broadcast failed (-26)')),
    });
    await expect(moveAndDeposit(refused.d, T, '425000')).rejects.toThrow();
    expect(refused.calls.slice(-2)).toEqual(['hold', 'let go']);
    const unknown = deps({ broadcastMove: () => Promise.reject(new Error('network down')) });
    await expect(moveAndDeposit(unknown.d, T, '425000')).rejects.toThrow();
    expect(unknown.calls.at(-1)).toBe('hold');
  });

  it('a compact move cannot ride a batch', async () => {
    const { d } = deps({
      buildMove: () => Promise.resolve({ pcztHex: 'aa', compactRequest: true }),
    });
    await expect(moveAndDeposit(d, T, '425000')).rejects.toThrow(/shape/);
  });
});

describe('a held deposit, from the chain alone', () => {
  const held: Held = { txHex: '', expiry: 141, moveTxid: TXID, moveExpiry: 140 };
  it('pays once the move is mined and while the deposit can still land', () => {
    expect(heldNext(held, 130, 135)).toBe('pay');
    expect(heldNext(held, 140, 140)).toBe('pay');
    expect(heldNext(held, 140, 141)).toBe('drop');
  });
  it('waits for an unmined move until the move itself can no longer land', () => {
    expect(heldNext(held, undefined, 139)).toBe('wait');
    // a few blocks past its expiry, so a mined move not yet indexed never looks lost
    expect(heldNext(held, undefined, 143)).toBe('wait');
    expect(heldNext(held, undefined, 144)).toBe('lost');
  });
});
