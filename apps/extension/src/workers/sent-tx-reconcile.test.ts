import { describe, expect, it } from 'vitest';
import {
  EXPIRY_GRACE_BLOCKS,
  parseExpiryHeight,
  reconcileSentTxs,
  type HistoryTx,
  type SentTxRecord,
} from './sent-tx-reconcile';

const rec = (over: Partial<SentTxRecord> = {}): SentTxRecord => ({
  walletId: 'w1',
  txid: 'aa',
  amount: '355000',
  fee: '10000',
  recipient: 't1abc',
  pool: 'ironwood',
  kind: 'send',
  sentAt: 1_700_000_000_000,
  ...over,
});

const chain = (over: Partial<Omit<HistoryTx, 'status'>> = {}): Omit<HistoryTx, 'status'> => ({
  id: 'aa',
  height: 3_437_366,
  type: 'send',
  amount: '999999',
  asset: 'ZEC',
  ...over,
});

describe('reconcileSentTxs', () => {
  it('shows a freshly broadcast send as pending, with the amount the user sent', () => {
    const { txs, confirm, prune } = reconcileSentTxs({
      chainTxs: [],
      sent: [rec()],
      scannedHeight: 3_437_000,
    });
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      id: 'aa',
      status: 'pending',
      height: 0,
      // what left the wallet: 355000 to the recipient + 10000 fee
      amount: '365000',
      recipientAmount: '355000',
      fee: '10000',
      recipient: 't1abc',
      type: 'send',
    });
    expect(confirm).toEqual([]);
    expect(prune).toEqual([]);
  });

  it('reports what left the wallet, not the notes spent as inputs', () => {
    // the real case: a 355,000 zat note spent to pay 50,000 with a 15,000 fee.
    // 290,000 comes back as change, so the wallet is 65,000 poorer — reporting
    // the 355,000 input total told the user they had spent everything.
    const { txs } = reconcileSentTxs({
      chainTxs: [chain({ height: 3_437_366, amount: '355000' })],
      sent: [rec({ amount: '50000', fee: '15000' })],
      scannedHeight: 3_437_400,
    });
    expect(txs[0]!.amount).toBe('65000');
    expect(txs[0]!.recipientAmount).toBe('50000');
    expect(txs[0]!.fee).toBe('15000');
    expect(txs[0]!.amountUpperBound).toBeUndefined();
  });

  it('survives a malformed amount without rendering NaN for money', () => {
    const { txs } = reconcileSentTxs({
      chainTxs: [],
      sent: [rec({ amount: 'not-a-number', fee: '15000' })],
      scannedHeight: 0,
    });
    expect(txs[0]!.amount).toBe('15000');
  });

  it('drops the upper-bound caveat once an exact local record supersedes it', () => {
    const { txs } = reconcileSentTxs({
      chainTxs: [chain({ amount: '355000', amountUpperBound: true })],
      sent: [rec({ amount: '50000', fee: '15000' })],
      scannedHeight: 3_437_400,
    });
    expect(txs[0]!.amount).toBe('65000');
    expect(txs[0]!.amountUpperBound).toBeUndefined();
  });

  it('preserves the upper-bound caveat on a send we never recorded', () => {
    const { txs } = reconcileSentTxs({
      chainTxs: [chain({ id: 'zz', amount: '355000', amountUpperBound: true })],
      sent: [],
      scannedHeight: 3_437_400,
    });
    expect(txs[0]).toMatchObject({ amount: '355000', amountUpperBound: true });
  });

  it('never treats a heightless chain entry as confirmation', () => {
    // this is exactly what markNotesSpentLocally leaves behind at broadcast:
    // our own txid, height 0, amount = full input total rather than the send
    const { txs, confirm } = reconcileSentTxs({
      chainTxs: [chain({ height: 0, amount: '5000000' })],
      sent: [rec()],
      scannedHeight: 3_437_000,
    });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.status).toBe('pending');
    expect(txs[0]!.amount).toBe('365000');
    expect(confirm).toEqual([]);
  });

  it('confirms once the chain supplies a real height, and asks for it to be stored', () => {
    const { txs, confirm } = reconcileSentTxs({
      chainTxs: [chain()],
      sent: [rec()],
      scannedHeight: 3_437_400,
    });
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      status: 'confirmed',
      height: 3_437_366,
      // chain wins on height, the record wins on everything it alone knows
      amount: '365000',
      recipientAmount: '355000',
      recipient: 't1abc',
      fee: '10000',
    });
    expect(confirm).toEqual([{ txid: 'aa', height: 3_437_366 }]);
  });

  it('does not re-request a write once the height is already stored', () => {
    const { confirm } = reconcileSentTxs({
      chainTxs: [chain()],
      sent: [rec({ confirmedHeight: 3_437_366 })],
      scannedHeight: 3_437_400,
    });
    expect(confirm).toEqual([]);
  });

  it('keeps a confirmed send confirmed when the chain entry disappears (rescan)', () => {
    const { txs } = reconcileSentTxs({
      chainTxs: [],
      sent: [rec({ confirmedHeight: 3_437_366 })],
      scannedHeight: 0,
    });
    expect(txs[0]).toMatchObject({ status: 'confirmed', height: 3_437_366 });
  });

  it('emits one row per txid — the local record and the chain entry never double up', () => {
    const { txs } = reconcileSentTxs({
      chainTxs: [chain(), chain({ id: 'bb', type: 'receive', height: 3_400_000 })],
      sent: [rec(), rec({ txid: 'aa' })],
      scannedHeight: 3_437_400,
    });
    expect(txs.map(t => t.id).sort()).toEqual(['aa', 'bb']);
  });

  it('prefers a chain copy that has a height over one that does not', () => {
    const { txs } = reconcileSentTxs({
      chainTxs: [chain({ height: 0 }), chain({ height: 3_437_366 })],
      sent: [],
      scannedHeight: 3_437_400,
    });
    expect(txs).toHaveLength(1);
    expect(txs[0]!.height).toBe(3_437_366);
  });

  it('passes chain-only transactions through untouched', () => {
    const { txs } = reconcileSentTxs({
      chainTxs: [chain({ id: 'cc', type: 'receive', amount: '42' })],
      sent: [],
      scannedHeight: 3_437_400,
    });
    expect(txs[0]).toMatchObject({ id: 'cc', type: 'receive', amount: '42', status: 'confirmed' });
    expect(txs[0]!.recipient).toBeUndefined();
  });

  describe('expiry', () => {
    it('stays pending while the wallet has not yet scanned past expiry', () => {
      const { txs, prune } = reconcileSentTxs({
        chainTxs: [],
        sent: [rec({ expiryHeight: 3_437_400 })],
        scannedHeight: 3_437_399,
      });
      expect(txs[0]!.status).toBe('pending');
      expect(prune).toEqual([]);
    });

    it('fails once scanning has passed expiry without seeing it', () => {
      const { txs, prune } = reconcileSentTxs({
        chainTxs: [],
        sent: [rec({ expiryHeight: 3_437_400 })],
        scannedHeight: 3_437_401,
      });
      expect(txs[0]!.status).toBe('failed');
      // shown, not yet deleted — the user has to be able to read it
      expect(prune).toEqual([]);
    });

    it('prunes only after the grace window past expiry', () => {
      const expiryHeight = 3_437_400;
      const justInside = reconcileSentTxs({
        chainTxs: [],
        sent: [rec({ expiryHeight })],
        scannedHeight: expiryHeight + EXPIRY_GRACE_BLOCKS,
      });
      expect(justInside.prune).toEqual([]);

      const past = reconcileSentTxs({
        chainTxs: [],
        sent: [rec({ expiryHeight })],
        scannedHeight: expiryHeight + EXPIRY_GRACE_BLOCKS + 1,
      });
      expect(past.prune).toEqual(['aa']);
      // still rendered on the pass that proposes the delete
      expect(past.txs[0]!.status).toBe('failed');
    });

    it('never expires a record with no expiry height, however far we have scanned', () => {
      for (const expiryHeight of [undefined, 0]) {
        const { txs, prune } = reconcileSentTxs({
          chainTxs: [],
          sent: [rec({ expiryHeight })],
          scannedHeight: 9_999_999,
        });
        expect(txs[0]!.status).toBe('pending');
        expect(prune).toEqual([]);
      }
    });

    it('never expires anything when the scan height is unknown', () => {
      const { txs, prune } = reconcileSentTxs({
        chainTxs: [],
        sent: [rec({ expiryHeight: 1 })],
        scannedHeight: 0,
      });
      expect(txs[0]!.status).toBe('pending');
      expect(prune).toEqual([]);
    });

    it('a confirmed transaction is never called failed, whatever its expiry', () => {
      const { txs, prune } = reconcileSentTxs({
        chainTxs: [chain()],
        sent: [rec({ expiryHeight: 1 })],
        scannedHeight: 9_999_999,
      });
      expect(txs[0]!.status).toBe('confirmed');
      expect(prune).toEqual([]);
    });
  });

  describe('ordering', () => {
    it('puts pending first, then failed, then confirmed by height', () => {
      const { txs } = reconcileSentTxs({
        chainTxs: [
          chain({ id: 'old', height: 3_000_000 }),
          chain({ id: 'new', height: 3_437_366 }),
        ],
        sent: [
          rec({ txid: 'p1', sentAt: 10 }),
          rec({ txid: 'p2', sentAt: 20 }),
          rec({ txid: 'f1', expiryHeight: 1 }),
        ],
        scannedHeight: 3_437_400,
      });
      expect(txs.map(t => t.id)).toEqual(['p2', 'p1', 'f1', 'new', 'old']);
    });
  });
});

describe('parseExpiryHeight', () => {
  const le32 = (n: number): string => {
    let out = '';
    for (let i = 0; i < 4; i++) {
      out += ((n >>> (8 * i)) & 0xff).toString(16).padStart(2, '0');
    }
    return out;
  };
  const v5 = (version: number, expiry: number): string =>
    le32(0x80000000 | version) +
    le32(0x26a7270a) +
    le32(0xc2d6d0b4) +
    le32(0) +
    le32(expiry) +
    'ff';

  it('reads the expiry height out of a v5 transaction', () => {
    expect(parseExpiryHeight(v5(5, 3_437_400))).toBe(3_437_400);
  });

  it('reads it out of a v6 (ironwood) transaction too', () => {
    expect(parseExpiryHeight(v5(6, 1))).toBe(1);
  });

  it('reports an explicit no-expiry transaction as 0, not as unknown', () => {
    expect(parseExpiryHeight(v5(5, 0))).toBe(0);
  });

  it('declines to guess at pre-v5 or malformed transactions', () => {
    expect(parseExpiryHeight(v5(4, 100))).toBeUndefined();
    // fOverwintered clear
    expect(parseExpiryHeight(le32(5) + '00'.repeat(40))).toBeUndefined();
    expect(parseExpiryHeight('')).toBeUndefined();
    expect(parseExpiryHeight('zz'.repeat(40))).toBeUndefined();
  });
});
