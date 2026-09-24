import { describe, expect, it } from 'vitest';
import {
  awaitingConfirmation,
  KEEP_FINISHED_MS,
  STALE_PENDING_MS,
  isTerminal,
  isTxOp,
  sortOps,
  sweep,
  type TxOp,
} from '.';

const op = (over: Partial<TxOp>): TxOp => ({
  opId: 'a',
  network: 'penumbra',
  label: 'send 1 UM',
  status: 'pending',
  startedAt: 0,
  updatedAt: 0,
  ...over,
});

describe('tx-ops', () => {
  it('only pending is non-terminal', () => {
    expect(isTerminal('pending')).toBe(false);
    for (const s of ['done', 'failed', 'unknown'] as const) {
      expect(isTerminal(s)).toBe(true);
    }
  });

  it('recognises a record', () => {
    expect(isTxOp(op({}))).toBe(true);
    expect(isTxOp({ opId: 'x' })).toBe(false);
    expect(isTxOp(null)).toBe(false);
  });

  it('sorts newest first', () => {
    const ops = sortOps([op({ opId: 'old', startedAt: 1 }), op({ opId: 'new', startedAt: 2 })]);
    expect(ops.map(o => o.opId)).toEqual(['new', 'old']);
  });

  it('marks a silent pending op unknown instead of failed', () => {
    const now = STALE_PENDING_MS + 1;
    const { stale, remove } = sweep([op({ updatedAt: 0 })], now);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ status: 'unknown', updatedAt: now });
    expect(remove).toEqual([]);
  });

  it('keeps a recent pending op alone', () => {
    expect(sweep([op({ updatedAt: 0 })], STALE_PENDING_MS - 1)).toEqual({ stale: [], remove: [] });
  });

  it('drops a finished op only once announced and old', () => {
    const late = KEEP_FINISHED_MS + 1;
    expect(sweep([op({ status: 'done', notified: true })], late).remove).toEqual(['a']);
    expect(sweep([op({ status: 'done', notified: false })], late).remove).toEqual([]);
    expect(sweep([op({ status: 'failed', notified: true })], 1).remove).toEqual([]);
  });

  it('awaits chain confirmation only for pending ops with a hash and endpoint', () => {
    const ops = [
      op({ opId: 'a', txId: 'h', restUrl: 'https://lcd' }),
      op({ opId: 'b', txId: 'h' }),
      op({ opId: 'c', status: 'done', txId: 'h', restUrl: 'https://lcd' }),
    ];
    expect(awaitingConfirmation(ops).map(o => o.opId)).toEqual(['a']);
  });
});
