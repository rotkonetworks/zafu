import { describe, expect, it, vi } from 'vitest';
import type { SentTxRecord } from './sent-tx-reconcile';
import { reconcileSentTxs } from './sent-tx-reconcile';
import { lookupOwnTx, ownTxHeights } from './own-tx-height';

const TEX_PAY = 'e62da7a4281993326214d49a26523288acda9c7d412110ae71b18d5d51e4cf34';

const rec = (over: Partial<SentTxRecord>): SentTxRecord => ({
  walletId: 'w',
  txid: TEX_PAY,
  amount: '110000000',
  fee: '10000',
  recipient: 'tex1glfs7yuku4mx57vxs9qerv0307lazcpef8s6h3',
  pool: 'transparent',
  kind: 'send',
  sentAt: 1,
  expiryHeight: 3_550_074,
  ...over,
});

/** a server that has `txid` mined at `height` (display byte order) */
const serverWith = (height: number | undefined) => ({
  getTransaction: vi.fn((hash: Uint8Array) => {
    const hex = Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
    return hex === TEX_PAY && height !== undefined
      ? Promise.resolve({ data: new Uint8Array([5]), height })
      : Promise.reject(new Error('not found'));
  }),
});

describe('transparent-only sends', () => {
  it('a mined tex payment is confirmed, not left waiting or declared failed at expiry', async () => {
    const sent = [rec({})];
    const found = await ownTxHeights(serverWith(3_549_956), sent, 3_550_200, new Map());
    expect(found).toEqual([{ txid: TEX_PAY, height: 3_549_956 }]);
    const { txs, confirm } = reconcileSentTxs({
      chainTxs: found.map(f => ({
        id: f.txid,
        height: f.height,
        type: 'send' as const,
        amount: '0',
        asset: 'ZEC',
      })),
      sent,
      // past the payment's expiry: without the lookup this read as "not mined in time"
      scannedHeight: 3_550_200,
    });
    expect(txs[0]).toMatchObject({
      status: 'confirmed',
      height: 3_549_956,
      amount: '110010000',
    });
    expect(confirm).toEqual([{ txid: TEX_PAY, height: 3_549_956 }]);
  });

  it('asks once per scanned height, and never about a shielded send or a confirmed one', async () => {
    const server = serverWith(undefined);
    const asked = new Map<string, number>();
    const sent = [
      rec({}),
      rec({ txid: 'aa'.repeat(32), pool: 'ironwood' }),
      rec({ txid: 'bb'.repeat(32), confirmedHeight: 100 }),
      rec({ txid: 'cc'.repeat(32), kind: 'shield' }),
    ];
    await ownTxHeights(server, sent, 10, asked);
    await ownTxHeights(server, sent, 10, asked);
    // one txid, both byte orders, one pass
    expect(server.getTransaction).toHaveBeenCalledTimes(2);
    await ownTxHeights(server, sent, 11, asked);
    expect(server.getTransaction).toHaveBeenCalledTimes(4);
  });

  it('in the mempool is found with no height; an unreachable server is "not seen"', async () => {
    const mempool = {
      getTransaction: () => Promise.resolve({ data: new Uint8Array([5]), height: 0 }),
    };
    expect(await lookupOwnTx(mempool, TEX_PAY)).toEqual({ found: true, height: undefined });
    expect(await lookupOwnTx(serverWith(undefined), TEX_PAY)).toEqual({ found: false });
  });
});
