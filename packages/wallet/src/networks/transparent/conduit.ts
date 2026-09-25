/**
 * One interface over every transparent chain zafu holds keys on (Noble,
 * Injective, ...), so the send/receive/home UI stays generic and each chain
 * only declares how it derives, reads balances and signs.
 *
 * Two key schemes today:
 * - cosmos (secp256k1, coin type 118): the shared cosmos signer
 * - ethermint (eth_secp256k1, coin type 60): networks/injective
 *
 * `conduitFor` picks by `COSMOS_CHAINS[id].keyAlgo`. The ethermint conduit must
 * never touch the coin-118 helpers: a prefix-swapped coin-118 address is a
 * valid-looking but wrong inj1 address, and funds sent there are lost.
 */

import { COSMOS_CHAINS, type CosmosChainId } from '../cosmos/chains';
import {
  buildMsgSend,
  buildMsgTransfer,
  calculateFee,
  deriveChainAddress,
  deriveCosmosWallet,
  estimateGas,
  signAndBroadcast,
} from '../cosmos/signer';
import { getAllBalances } from '../cosmos/client';
import { deriveInjectiveAddress } from '../injective/derive';
import { queryInjectiveBalances } from '../injective/client';
import { shieldInToPenumbra, withdrawToExchange } from '../injective/conduit';
import { requestInjectiveFeeGrant, type FeeGrantPurpose } from '../injective/feegrant';

export interface TransparentCoin {
  denom: string;
  amount: bigint;
}

/** a fee in the chain's gas asset */
export interface TransparentFee {
  denom: string;
  /** base units of the gas asset */
  amount: bigint;
  gas: string;
}

export interface TransparentTxResult {
  txHash: string;
  code: number;
  rawLog: string;
}

interface SignArgs {
  mnemonic: string;
  accountIndex: number;
  /**
   * The address every balance check was made against. The conduit re-derives
   * it from `accountIndex` and refuses to sign if they differ, so a stale
   * selection can never spend from another address.
   */
  expectedAddress?: string;
  coin: { denom: string; amount: string };
  memo?: string;
  /** x/feegrant granter paying the fee (from requestFeeGrant) */
  feeGranter?: string;
}

export interface SendArgs extends SignArgs {
  to: string;
}

export interface IbcArgs extends SignArgs {
  sourceChannel: string;
  receiver: string;
  /** nanosecond timestamp */
  timeoutTimestamp: bigint;
}

export type TxKind = 'send' | 'ibc';

export interface ChainConduit {
  chainId: CosmosChainId;
  deriveAddress(mnemonic: string, accountIndex: number): Promise<string>;
  /** every bank balance on the address, as the chain spells the denoms */
  queryBalances(address: string, endpoint?: string): Promise<TransparentCoin[]>;
  /** what one tx of this kind costs, in the gas asset */
  feeFor(kind: TxKind): TransparentFee;
  send(args: SendArgs): Promise<TransparentTxResult>;
  ibcTransfer(args: IbcArgs): Promise<TransparentTxResult>;
  /** ask the chain's gas sponsor for a fee allowance; only on chains with one */
  requestFeeGrant?(address: string, kind: TxKind): Promise<{ granter: string }>;
}

const FEE_GRANT_LAG = /fee-grant not found/i;

/**
 * A fresh grant can be in a block the sponsor's node has seen but this node has
 * not yet. That CheckTx rejection consumes no sequence, so resend once.
 */
async function withGrantRetry(
  feeGranter: string | undefined,
  send: () => Promise<TransparentTxResult>,
  wait: (ms: number) => Promise<void>,
): Promise<TransparentTxResult> {
  const first = await send();
  if (feeGranter && first.code !== 0 && FEE_GRANT_LAG.test(first.rawLog)) {
    await wait(3000);
    return send();
  }
  return first;
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });

async function assertAddress(
  derive: () => Promise<string>,
  expected: string | undefined,
): Promise<void> {
  if (expected !== undefined && (await derive()) !== expected) {
    throw new Error('address/index mismatch - refresh and retry');
  }
}

function cosmosConduit(chainId: CosmosChainId): ChainConduit {
  const deriveAddress = async (mnemonic: string, accountIndex: number) =>
    deriveChainAddress((await deriveCosmosWallet(mnemonic, accountIndex)).address, chainId);
  const feeFor = (kind: TxKind): TransparentFee => {
    const typeUrl =
      kind === 'ibc' ? '/ibc.applications.transfer.v1.MsgTransfer' : '/cosmos.bank.v1beta1.MsgSend';
    const fee = calculateFee(chainId, estimateGas(chainId, '', [{ typeUrl, value: {} }]));
    const coin = fee.amount[0];
    if (!coin) {
      throw new Error(`no fee coin for ${chainId}`);
    }
    return { denom: coin.denom, amount: BigInt(coin.amount), gas: fee.gas };
  };
  const stdFee = (kind: TxKind) => {
    const f = feeFor(kind);
    return { amount: [{ denom: f.denom, amount: f.amount.toString() }], gas: f.gas };
  };
  const broadcast = async (
    args: SignArgs,
    kind: TxKind,
    msg: (from: string) => ReturnType<typeof buildMsgSend>,
  ): Promise<TransparentTxResult> => {
    const from = await deriveAddress(args.mnemonic, args.accountIndex);
    if (args.expectedAddress !== undefined && from !== args.expectedAddress) {
      throw new Error('address/index mismatch - refresh and retry');
    }
    const res = await signAndBroadcast(
      chainId,
      args.mnemonic,
      [msg(from)],
      stdFee(kind),
      args.memo ?? '',
      args.accountIndex,
    );
    // SDK 0.50+ no longer fills rawLog; the code is what callers act on
    return {
      txHash: res.transactionHash,
      code: res.code,
      rawLog: res.code === 0 ? '' : `tx failed (code ${res.code})`,
    };
  };
  return {
    chainId,
    deriveAddress,
    queryBalances: async (address, endpoint) =>
      (await getAllBalances(chainId, address, endpoint)).map(b => ({
        denom: b.denom,
        amount: b.amount,
      })),
    feeFor,
    send: args =>
      broadcast(args, 'send', from =>
        buildMsgSend({ fromAddress: from, toAddress: args.to, amount: [args.coin] }),
      ),
    ibcTransfer: args =>
      broadcast(args, 'ibc', from =>
        buildMsgTransfer({
          sourcePort: 'transfer',
          sourceChannel: args.sourceChannel,
          token: args.coin,
          sender: from,
          receiver: args.receiver,
          timeoutTimestamp: args.timeoutTimestamp,
          memo: args.memo,
        }),
      ),
  };
}

/** Injective's conduit txs use a fixed gas limit; the whole fee is paid in INJ. */
const ETHERMINT_GAS_LIMIT = '400000';

function ethermintConduit(
  chainId: CosmosChainId,
  deps: { wait: (ms: number) => Promise<void>; fetchFn?: typeof fetch } = { wait: sleep },
): ChainConduit {
  const cfg = COSMOS_CHAINS[chainId];
  const sponsorUrl = cfg.gasSponsorUrl;
  const gas = cfg.gasAsset ?? { symbol: cfg.symbol, denom: cfg.denom, decimals: cfg.decimals };
  const feeFor = (): TransparentFee => {
    const perGas = BigInt(/^\d+/.exec(cfg.gasPrice)?.[0] ?? '0');
    return {
      denom: gas.denom,
      amount: perGas * BigInt(ETHERMINT_GAS_LIMIT),
      gas: ETHERMINT_GAS_LIMIT,
    };
  };
  const stdFee = () => {
    const f = feeFor();
    return { amount: [{ denom: f.denom, amount: f.amount.toString() }], gas: f.gas };
  };
  const deriveAddress = (mnemonic: string, accountIndex: number) =>
    deriveInjectiveAddress(mnemonic, accountIndex);
  const common = (args: SignArgs) => ({
    mnemonic: args.mnemonic,
    accountIndex: args.accountIndex,
    restUrl: cfg.restEndpoint,
    chainId: cfg.chainId,
    fee: stdFee(),
    feeGranter: args.feeGranter,
    fetchFn: deps.fetchFn,
  });
  const toResult = (r: { txhash: string; code: number; rawLog: string }): TransparentTxResult => ({
    txHash: r.txhash,
    code: r.code,
    rawLog: r.rawLog,
  });
  return {
    chainId,
    deriveAddress,
    // the LCD bank endpoint; the tendermint RPC `endpoint` does not apply here
    queryBalances: async address =>
      (await queryInjectiveBalances(cfg.restEndpoint, address, cfg.denom, deps.fetchFn)).all ?? [],
    feeFor,
    send: async args => {
      await assertAddress(
        () => deriveAddress(args.mnemonic, args.accountIndex),
        args.expectedAddress,
      );
      return withGrantRetry(
        args.feeGranter,
        async () =>
          toResult(
            await withdrawToExchange({
              ...common(args),
              toAddress: args.to,
              amount: args.coin,
              memo: args.memo,
            }),
          ),
        deps.wait,
      );
    },
    ibcTransfer: async args => {
      await assertAddress(
        () => deriveAddress(args.mnemonic, args.accountIndex),
        args.expectedAddress,
      );
      return withGrantRetry(
        args.feeGranter,
        async () =>
          toResult(
            await shieldInToPenumbra({
              ...common(args),
              sourceChannel: args.sourceChannel,
              penumbraReceiver: args.receiver,
              token: args.coin,
              timeoutTimestamp: args.timeoutTimestamp,
              memo: args.memo,
            }),
          ),
        deps.wait,
      );
    },
    ...(sponsorUrl
      ? {
          requestFeeGrant: (address: string, kind: TxKind) => {
            const purpose: FeeGrantPurpose = kind === 'ibc' ? 'shield' : 'send';
            return requestInjectiveFeeGrant(sponsorUrl, address, deps.fetchFn ?? fetch, purpose);
          },
        }
      : {}),
  };
}

/** the conduit for a transparent chain, chosen by its key scheme */
export function conduitFor(chainId: CosmosChainId): ChainConduit {
  return COSMOS_CHAINS[chainId].keyAlgo === 'eth_secp256k1'
    ? ethermintConduit(chainId)
    : cosmosConduit(chainId);
}

/** test seam: an ethermint conduit with injected wait/fetch */
export const ethermintConduitForTest = ethermintConduit;
