import { Client, Transport } from '@connectrpc/connect';
import { createClient } from './utils';
import { TendermintProxyService } from '@penumbra-zone/protobuf';
import { TransactionId } from '@penumbra-zone/protobuf/penumbra/core/txhash/v1/txhash_pb';
import { Transaction } from '@penumbra-zone/protobuf/penumbra/core/transaction/v1/transaction_pb';
import type { TendermintQuerierInterface } from '@rotko/penumbra-types/querier';

declare global {
  var __DEV__: boolean | undefined;
}

/**
 * How long a tip height may be reused.
 *
 * The view service asks for the tip on every `Balances` and `Status` call (price
 * relevance, sync progress), and the wallet is not the only caller: a connected
 * dapp polling balances made that a GetStatus round trip per call - ~100ms of the
 * service worker's single thread, on the path the wallet's own RPCs queue behind.
 * The tip only moves every few seconds, so a few seconds of reuse costs nothing
 * and takes the round trip off the hot path.
 */
const LATEST_HEIGHT_TTL_MS = 10_000;

export class TendermintQuerier implements TendermintQuerierInterface {
  private readonly client: Client<typeof TendermintProxyService>;
  private latestHeight: { value: bigint; at: number } | undefined;
  private inFlight: Promise<bigint | undefined> | undefined;

  constructor({ grpcEndpoint, transport }: { grpcEndpoint: string; transport?: Transport }) {
    this.client = createClient(grpcEndpoint, TendermintProxyService, transport);
  }

  async latestBlockHeight() {
    const cached = this.latestHeight;
    if (cached && Date.now() - cached.at < LATEST_HEIGHT_TTL_MS) {
      return cached.value;
    }

    // Concurrent callers (a dapp's balances stream alongside the UI's, say)
    // share one round trip instead of racing their own.
    this.inFlight ??= this.client
      .getStatus({})
      .then(({ syncInfo }) => {
        const value = syncInfo?.latestBlockHeight;
        if (value !== undefined) {
          this.latestHeight = { value, at: Date.now() };
        }
        return value;
      })
      .catch((e: unknown) => {
        if (globalThis.__DEV__) {
          console.debug(e);
        }
        return undefined; // never cached: the next call retries
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }

  async broadcastTx(tx: Transaction) {
    const params = tx.toBinary();
    // Note that "synchronous" here means "wait for the tx to be accepted by
    // the fullnode", not "wait for the tx to be included on chain.
    const { hash, log, code } = await this.client.broadcastTxSync({ params });

    if (code !== 0n) {
      throw new Error(`Tendermint error ${code.toString()}: ${log}`);
    }

    return new TransactionId({ inner: hash });
  }

  async getTransaction(txId: TransactionId): Promise<{ height: bigint; transaction: Transaction }> {
    const res = await this.client.getTx({ hash: txId.inner });
    const transaction = Transaction.fromBinary(res.tx);
    return { height: res.height, transaction };
  }
}
