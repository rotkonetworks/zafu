/**
 * Injective node client for the receive-and-shield conduit: the two live
 * operations (account query, broadcast) plus the two message builders.
 *
 * We talk to the cosmos REST/LCD endpoint rather than cosmjs's StargateClient,
 * because StargateClient's getAccount cannot parse Injective's EthAccount. The
 * LCD serialises the account to JSON, so base_account's number/sequence are
 * directly readable - and decodeEthAccount (tx.ts) covers the proto path.
 *
 * SAFETY: broadcastInjectiveTx submits a signed tx to the network. It is only
 * ever reached from an explicit user-approved send, and the whole Injective
 * path stays disabled until the testnet round-trip in #34 passes.
 */

import { toBase64 } from '@cosmjs/encoding';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { MsgTransfer } from 'cosmjs-types/ibc/applications/transfer/v1/tx';
import type { Coin } from 'cosmjs-types/cosmos/base/v1beta1/coin';
import type { EncodedMsg } from './tx';

type FetchFn = typeof fetch;

export interface InjectiveAccount {
  accountNumber: bigint;
  sequence: number;
}

const trimUrl = (u: string) => u.replace(/\/$/, '');

/**
 * Query account_number + sequence for an `inj1…` address. Injective returns an
 * `EthAccount`; over LCD it is JSON with the standard `base_account` fields.
 * Throws if the account does not exist yet (unfunded - it must receive first).
 */
export async function queryInjectiveAccount(
  restUrl: string,
  address: string,
  fetchFn: FetchFn = fetch,
): Promise<InjectiveAccount> {
  const res = await fetchFn(`${trimUrl(restUrl)}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) {
    throw new Error(`injective account query failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    account?: {
      base_account?: { account_number?: string; sequence?: string };
      account_number?: string;
      sequence?: string;
    };
  };
  const acct = json.account ?? {};
  const base = acct.base_account ?? acct;
  if (base.account_number == null || base.sequence == null) {
    throw new Error('injective account not found (unfunded - receive USDC first)');
  }
  return { accountNumber: BigInt(base.account_number), sequence: Number(base.sequence) };
}

export interface InjectiveBalances {
  /** USDC.inj (erc20 denom) balance in base units (6-dec). */
  usdc: bigint;
  /** INJ gas-token balance in base units (18-dec). */
  inj: bigint;
}

/**
 * Read the USDC.inj (erc20 denom) and INJ (gas) balances for an `inj1…`
 * address over the LCD bank endpoint.
 *
 * We hit the all-balances endpoint and filter locally rather than
 * `.../by_denom?denom=…`: the erc20 denom is `erc20:0x…` and the colon+hex
 * would need URL-encoding, an easy place to silently get a 0. Unlike the auth
 * endpoint (queryInjectiveAccount), this returns 200 with an empty list for a
 * never-funded address, so both balances default to 0n - exactly the
 * "watch funds arrive" behaviour the receive panel wants.
 *
 * On-chain denoms are case-sensitive; the canonical USDC.inj denom is the
 * EIP-55 mixed-case checksummed form (verified live: the lowercase variant has
 * zero supply). We match case-insensitively anyway so a differently-cased LCD
 * response can never read as an empty balance.
 */
export async function queryInjectiveBalances(
  restUrl: string,
  address: string,
  usdcDenom: string,
  fetchFn: FetchFn = fetch,
): Promise<InjectiveBalances> {
  const res = await fetchFn(`${trimUrl(restUrl)}/cosmos/bank/v1beta1/balances/${address}`);
  if (!res.ok) {
    throw new Error(`injective balance query failed: ${res.status}`);
  }
  const json = (await res.json()) as { balances?: { denom?: string; amount?: string }[] };
  const wantUsdc = usdcDenom.toLowerCase();
  let usdc = 0n;
  let inj = 0n;
  for (const b of json.balances ?? []) {
    if (!b.denom || b.amount == null) {
      continue;
    }
    const denom = b.denom.toLowerCase();
    if (denom === wantUsdc) {
      usdc = BigInt(b.amount);
    } else if (denom === 'inj') {
      inj = BigInt(b.amount);
    }
  }
  return { usdc, inj };
}

export interface InjectiveTxStatus {
  /** false while the tx is still pending (LCD returns 404 until included). */
  found: boolean;
  /** 0 = included and succeeded; non-zero = included but failed. */
  code?: number;
  height?: string;
  rawLog?: string;
}

/**
 * Poll a tx hash on the LCD. A BROADCAST_MODE_SYNC broadcast (see
 * broadcastInjectiveTx) with code 0 only means "accepted into the mempool", not
 * "included in a block" - the tx endpoint 404s until inclusion. This lets the
 * UI move an honest submitted -> done only once the tx is actually on-chain.
 */
export async function queryInjectiveTx(
  restUrl: string,
  hash: string,
  fetchFn: FetchFn = fetch,
): Promise<InjectiveTxStatus> {
  const res = await fetchFn(`${trimUrl(restUrl)}/cosmos/tx/v1beta1/txs/${hash}`);
  if (res.status === 404) {
    return { found: false };
  }
  if (!res.ok) {
    throw new Error(`injective tx query failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    tx_response?: { code?: number; height?: string; raw_log?: string };
  };
  const r = json.tx_response;
  if (!r || r.height == null || r.height === '0' || r.height === '') {
    return { found: false };
  }
  return { found: true, code: r.code ?? 0, height: r.height, rawLog: r.raw_log ?? '' };
}

export interface BroadcastResult {
  txhash: string;
  /** 0 = accepted into mempool; non-zero = rejected (see rawLog) */
  code: number;
  rawLog: string;
}

/** Broadcast a signed TxRaw in sync mode via the cosmos REST tx endpoint. */
export async function broadcastInjectiveTx(
  restUrl: string,
  txRawBytes: Uint8Array,
  fetchFn: FetchFn = fetch,
): Promise<BroadcastResult> {
  const res = await fetchFn(`${trimUrl(restUrl)}/cosmos/tx/v1beta1/txs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx_bytes: toBase64(txRawBytes), mode: 'BROADCAST_MODE_SYNC' }),
  });
  const json = (await res.json()) as {
    tx_response?: { txhash?: string; code?: number; raw_log?: string };
  };
  const r = json.tx_response ?? {};
  return { txhash: r.txhash ?? '', code: r.code ?? -1, rawLog: r.raw_log ?? '' };
}

/** bank MsgSend - the withdraw leg (inj -> exchange deposit address). */
export function buildMsgSend(fromAddress: string, toAddress: string, amount: Coin[]): EncodedMsg {
  return {
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: MsgSend.encode(MsgSend.fromPartial({ fromAddress, toAddress, amount })).finish(),
  };
}

export interface IbcTransferParams {
  sourceChannel: string;
  sender: string;
  /** the Penumbra receiver (shield target) */
  receiver: string;
  token: Coin;
  /** nanosecond timeout timestamp */
  timeoutTimestamp: bigint;
  memo?: string;
}

/** IBC MsgTransfer - the shield-in leg (inj -> Penumbra over the channel). */
export function buildMsgTransfer(p: IbcTransferParams): EncodedMsg {
  return {
    typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
    value: MsgTransfer.encode(
      MsgTransfer.fromPartial({
        sourcePort: 'transfer',
        sourceChannel: p.sourceChannel,
        token: p.token,
        sender: p.sender,
        receiver: p.receiver,
        timeoutTimestamp: p.timeoutTimestamp,
        memo: p.memo ?? '',
      }),
    ).finish(),
  };
}
