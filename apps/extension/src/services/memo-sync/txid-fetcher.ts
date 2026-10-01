import { bucketOf, type MemoFetcher } from './types';

/** display-order txid hex -> the wire-order bytes lightwalletd's TxFilter.hash takes */
const wireTxid = (displayHex: string): Uint8Array =>
  Uint8Array.from(displayHex.match(/../g) ?? [], b => parseInt(b, 16)).reverse();

/**
 * Memos on a standard lightwalletd: fetch each of the wallet's own
 * transactions by id, as every lightwalletd wallet does - it has no
 * whole-block rpc to hide them among. One event per height, in the shape the
 * block-range fetcher yields, so the decoder is shared. A failed fetch throws
 * rather than yielding nothing, so the caller never records an unread
 * transaction as scanned.
 */
export const txidMemoFetcher = (
  client: { getTransaction(txid: Uint8Array): Promise<{ data: Uint8Array }> },
  txidsByHeight: ReadonlyMap<number, ReadonlySet<string>>,
): MemoFetcher =>
  async function* (_walletId, _owned, ctx) {
    let done = 0;
    for (const [height, txids] of txidsByHeight) {
      if (ctx.signal.aborted) {
        return;
      }
      const txs = await Promise.all(
        [...txids].map(async id => ({ data: (await client.getTransaction(wireTxid(id))).data })),
      );
      yield { bucketStart: bucketOf(height), blocks: [{ height, txs }] };
      ctx.onProgress?.(++done, txidsByHeight.size);
    }
  };
