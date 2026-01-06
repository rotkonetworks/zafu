/**
 * cosmos client - balance queries and tx building
 *
 * uses @cosmjs/stargate for RPC queries
 * transactions are built unsigned for zigner signing
 */

import { StargateClient } from '@cosmjs/stargate';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import type { CosmosChainId } from './chains';
import { COSMOS_CHAINS } from './chains';

/** cached clients per chain */
const clients: Map<CosmosChainId, StargateClient> = new Map();

/** get or create client for chain */
export async function getClient(chainId: CosmosChainId): Promise<StargateClient> {
  let client = clients.get(chainId);
  if (client) return client;

  const config = COSMOS_CHAINS[chainId];
  client = await StargateClient.connect(config.rpcEndpoint);
  clients.set(chainId, client);
  return client;
}

/** disconnect all clients */
export function disconnectAll(): void {
  for (const client of clients.values()) {
    client.disconnect();
  }
  clients.clear();
}

/** balance result */
export interface CosmosBalance {
  /** amount in smallest unit */
  amount: bigint;
  /** denom */
  denom: string;
}

/** get native balance for address */
export async function getBalance(
  chainId: CosmosChainId,
  address: string
): Promise<CosmosBalance> {
  const client = await getClient(chainId);
  const config = COSMOS_CHAINS[chainId];

  const balance = await client.getBalance(address, config.denom);

  return {
    amount: BigInt(balance.amount),
    denom: balance.denom,
  };
}

/** get all balances for address */
export async function getAllBalances(
  chainId: CosmosChainId,
  address: string
): Promise<CosmosBalance[]> {
  const client = await getClient(chainId);
  const balances = await client.getAllBalances(address);

  return balances.map(b => ({
    amount: BigInt(b.amount),
    denom: b.denom,
  }));
}

/** get account info (for nonce/sequence) */
export async function getAccount(
  chainId: CosmosChainId,
  address: string
): Promise<{ accountNumber: number; sequence: number } | null> {
  const client = await getClient(chainId);
  const account = await client.getAccount(address);

  if (!account) return null;

  return {
    accountNumber: account.accountNumber,
    sequence: account.sequence,
  };
}

/** get chain height */
export async function getHeight(chainId: CosmosChainId): Promise<number> {
  const client = await getClient(chainId);
  return client.getHeight();
}

/** convert address between chains (same pubkey, different prefix) */
export function convertAddress(
  address: string,
  targetChain: CosmosChainId
): string {
  const { data } = fromBech32(address);
  const targetPrefix = COSMOS_CHAINS[targetChain].bech32Prefix;
  return toBech32(targetPrefix, data);
}

/** derive addresses for all chains from one address */
export function deriveAllAddresses(
  sourceAddress: string
): Record<CosmosChainId, string> {
  const { data } = fromBech32(sourceAddress);

  const addresses: Record<string, string> = {};
  for (const [chainId, config] of Object.entries(COSMOS_CHAINS)) {
    addresses[chainId] = toBech32(config.bech32Prefix, data);
  }

  return addresses as Record<CosmosChainId, string>;
}

/** build unsigned MsgSend for zigner signing */
export interface UnsignedSend {
  chainId: string;
  accountNumber: number;
  sequence: number;
  fee: {
    amount: { denom: string; amount: string }[];
    gas: string;
  };
  msgs: {
    typeUrl: string;
    value: {
      fromAddress: string;
      toAddress: string;
      amount: { denom: string; amount: string }[];
    };
  }[];
  memo: string;
}

export async function buildUnsignedSend(
  chainId: CosmosChainId,
  fromAddress: string,
  toAddress: string,
  amount: bigint,
  memo = ''
): Promise<UnsignedSend> {
  const config = COSMOS_CHAINS[chainId];
  const account = await getAccount(chainId, fromAddress);

  if (!account) {
    throw new Error(`account not found: ${fromAddress}`);
  }

  // estimate gas (simple send is ~80k)
  const gasLimit = '100000';

  // parse gas price
  const gasPriceMatch = config.gasPrice.match(/^([\d.]+)(.+)$/);
  if (!gasPriceMatch) {
    throw new Error(`invalid gas price format: ${config.gasPrice}`);
  }
  const [, priceStr, gasDenom] = gasPriceMatch;
  const gasAmount = Math.ceil(parseFloat(priceStr!) * parseInt(gasLimit)).toString();

  return {
    chainId: config.chainId,
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    fee: {
      amount: [{ denom: gasDenom!, amount: gasAmount }],
      gas: gasLimit,
    },
    msgs: [
      {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress,
          toAddress,
          amount: [{ denom: config.denom, amount: amount.toString() }],
        },
      },
    ],
    memo,
  };
}

/** encode unsigned tx for signing (amino JSON format for zigner) */
export function encodeForSigning(tx: UnsignedSend): string {
  // amino sign doc format
  const signDoc = {
    chain_id: tx.chainId,
    account_number: tx.accountNumber.toString(),
    sequence: tx.sequence.toString(),
    fee: {
      amount: tx.fee.amount,
      gas: tx.fee.gas,
    },
    msgs: tx.msgs.map(m => ({
      type: 'cosmos-sdk/MsgSend',
      value: {
        from_address: m.value.fromAddress,
        to_address: m.value.toAddress,
        amount: m.value.amount,
      },
    })),
    memo: tx.memo,
  };

  // sort keys for canonical JSON (required for signing)
  return JSON.stringify(signDoc, Object.keys(signDoc).sort());
}
