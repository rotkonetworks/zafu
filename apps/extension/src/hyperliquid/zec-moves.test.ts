import { describe, expect, it } from 'vitest';
import type { UnitOperation } from '@repo/wallet/networks/hyperliquid/unit';
import { zecMoveStatus, type ZecMove } from './zec-moves';

const ACCOUNT = '0xee119c2cc01f4b545020a0df05cd1e63b657d8e5';
const deposit: ZecMove = {
  v: 1,
  id: 'd',
  way: 'deposit',
  wallet: 'v1',
  account: ACCOUNT,
  from: 'main',
  zat: '10000000',
  at: 1,
  tx: 'ABCD12',
};
const withdraw: ZecMove = { ...deposit, id: 'w', way: 'withdraw', tx: `${ACCOUNT}:1700000000000` };
const op = (o: Partial<UnitOperation>): UnitOperation => ({
  sourceTx: 'abcd12:0',
  way: 'deposit',
  zat: 10_000_000n,
  state: 'waitForSrcTxFinalization',
  createdAt: '',
  ...o,
});

describe('where a zec move stands', () => {
  it('says only that it was sent until unit knows it', () => {
    expect(zecMoveStatus(deposit, undefined)).toEqual({
      line: 'unit has not been asked yet',
      over: false,
      failed: false,
    });
    expect(zecMoveStatus(deposit, []).line).toBe('sent · unit sees it after its first block');
    expect(zecMoveStatus(withdraw, []).line).toBe('sent · unit has not picked it up yet');
  });

  it('follows a deposit by its txid, whatever the case, counting real confirmations', () => {
    expect(zecMoveStatus(deposit, [op({ confirmations: 12 })]).line).toBe(
      '12 of 300 confirmations',
    );
    expect(zecMoveStatus(deposit, [op({})]).line).toBe('waiting for confirmations');
    expect(zecMoveStatus(deposit, [op({ state: 'signTx' })]).line).toBe('unit is sending it on');
  });

  it("never reads another move's operation as its own", () => {
    // another deposit, and a withdrawal whose source happens to share the prefix
    const others = [
      op({ sourceTx: 'ffff:0', state: 'done' }),
      op({ way: 'withdraw', state: 'done' }),
    ];
    expect(zecMoveStatus(deposit, others).over).toBe(false);
    expect(zecMoveStatus(withdraw, [op({ state: 'done' })]).over).toBe(false);
  });

  it('follows a withdrawal by its sender and nonce', () => {
    const mine = op({
      way: 'withdraw',
      sourceTx: `0xEE119C2CC01F4B545020A0DF05CD1E63B657D8E5:1700000000000`,
      state: 'readyForWithdrawQueue',
    });
    expect(zecMoveStatus(withdraw, [mine])).toEqual({
      line: "in unit's withdrawal queue",
      over: false,
      failed: false,
    });
  });

  it('knows a deposit with no txid yet by its exact amount, only among later operations', () => {
    const unsent: ZecMove = { ...deposit, tx: '', at: Date.parse('2026-11-16T10:00:00Z') };
    expect(zecMoveStatus(unsent, []).line).toBe('leaving your zcash wallet');
    const later = op({ sourceTx: 'ffff:0', createdAt: '2026-11-16T10:05:00Z', confirmations: 3 });
    expect(zecMoveStatus(unsent, [later]).line).toBe('3 of 300 confirmations');
    // an older deposit of the same amount is not this one
    expect(zecMoveStatus(unsent, [{ ...later, createdAt: '2026-11-15T10:05:00Z' }]).line).toBe(
      'leaving your zcash wallet',
    );
    expect(zecMoveStatus(unsent, [{ ...later, zat: 10_000_001n }]).line).toBe(
      'leaving your zcash wallet',
    );
  });

  it('ends on done or failure, and says which', () => {
    expect(zecMoveStatus(deposit, [op({ state: 'done' })])).toEqual({
      line: 'arrived',
      over: true,
      failed: false,
    });
    expect(zecMoveStatus(deposit, [op({ state: 'failure' })])).toMatchObject({
      over: true,
      failed: true,
    });
  });
});
