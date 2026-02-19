/**
 * cosmos signer - key derivation and transaction signing
 *
 * uses @cosmjs for:
 * - HD wallet derivation (m/44'/118'/0'/0/n)
 * - amino and direct signing
 * - transaction broadcast
 */

import { Secp256k1HdWallet, makeCosmoshubPath } from '@cosmjs/amino';
import { SigningStargateClient, GasPrice } from '@cosmjs/stargate';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import type { Coin, StdFee } from '@cosmjs/amino';
import type { DeliverTxResponse } from '@cosmjs/stargate';
import { COSMOS_CHAINS, type CosmosChainId } from './chains';

/** encode object for cosmos messages */
export interface EncodeObject {
  typeUrl: string;
  value: unknown;
}

/**
 * Cosmos HD path m/44'/118'/0'/0/{accountIndex}
 * Uses makeCosmoshubPath from @cosmjs/amino which returns proper HdPath type
 */
const cosmosHdPath = (accountIndex: number) => makeCosmoshubPath(accountIndex);

/** derived cosmos wallet */
export interface CosmosWallet {
  address: string;
  pubkey: Uint8Array;
  signer: Secp256k1HdWallet;
}

/** derive cosmos wallet from mnemonic */
export async function deriveCosmosWallet(
  mnemonic: string,
  accountIndex = 0,
  prefix = 'osmo'
): Promise<CosmosWallet> {
  const signer = await Secp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix,
    hdPaths: [cosmosHdPath(accountIndex)],
  });

  const [account] = await signer.getAccounts();
  if (!account) {
    throw new Error('failed to derive cosmos account');
  }

  return {
    address: account.address,
    pubkey: account.pubkey,
    signer,
  };
}

/** derive address for specific chain from existing address */
export function deriveChainAddress(address: string, chainId: CosmosChainId): string {
  const { data } = fromBech32(address);
  const prefix = COSMOS_CHAINS[chainId].bech32Prefix;
  return toBech32(prefix, data);
}

/** derive addresses for all chains from one address */
export function deriveAllChainAddresses(address: string): Record<CosmosChainId, string> {
  const { data } = fromBech32(address);
  const addresses: Record<string, string> = {};

  for (const [chainId, config] of Object.entries(COSMOS_CHAINS)) {
    addresses[chainId] = toBech32(config.bech32Prefix, data);
  }

  return addresses as Record<CosmosChainId, string>;
}

/** cached signing clients */
const signingClients: Map<string, SigningStargateClient> = new Map();

/** get or create signing client for chain */
export async function getSigningClient(
  chainId: CosmosChainId,
  signer: Secp256k1HdWallet
): Promise<SigningStargateClient> {
  const cacheKey = `${chainId}-${(await signer.getAccounts())[0]?.address}`;
  let client = signingClients.get(cacheKey);
  if (client) return client;

  const config = COSMOS_CHAINS[chainId];
  client = await SigningStargateClient.connectWithSigner(config.rpcEndpoint, signer, {
    gasPrice: GasPrice.fromString(config.gasPrice),
  });

  signingClients.set(cacheKey, client);
  return client;
}

/** disconnect all signing clients */
export function disconnectSigningClients(): void {
  for (const client of signingClients.values()) {
    client.disconnect();
  }
  signingClients.clear();
}

/** create signing client from mnemonic for specific chain */
export async function createSigningClient(
  chainId: CosmosChainId,
  mnemonic: string,
  accountIndex = 0
): Promise<{ client: SigningStargateClient; address: string }> {
  const config = COSMOS_CHAINS[chainId];

  const signer = await Secp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: config.bech32Prefix,
    hdPaths: [cosmosHdPath(accountIndex)],
  });

  const [account] = await signer.getAccounts();
  if (!account) {
    throw new Error('failed to derive account');
  }

  const client = await SigningStargateClient.connectWithSigner(config.rpcEndpoint, signer, {
    gasPrice: GasPrice.fromString(config.gasPrice),
  });

  return { client, address: account.address };
}

/** sign and broadcast a transaction */
export async function signAndBroadcast(
  chainId: CosmosChainId,
  mnemonic: string,
  messages: EncodeObject[],
  fee: StdFee | 'auto',
  memo = '',
  accountIndex = 0
): Promise<DeliverTxResponse> {
  const { client, address } = await createSigningClient(chainId, mnemonic, accountIndex);

  try {
    return await client.signAndBroadcast(address, messages, fee, memo);
  } finally {
    client.disconnect();
  }
}

/** simple MsgSend */
export interface SendParams {
  fromAddress: string;
  toAddress: string;
  amount: Coin[];
}

/** build MsgSend encode object */
export function buildMsgSend(params: SendParams): EncodeObject {
  return {
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: {
      fromAddress: params.fromAddress,
      toAddress: params.toAddress,
      amount: params.amount,
    },
  };
}

/** IBC MsgTransfer */
export interface IbcTransferParams {
  sourcePort: string;
  sourceChannel: string;
  token: Coin;
  sender: string;
  receiver: string;
  timeoutHeight?: { revisionNumber: bigint; revisionHeight: bigint };
  timeoutTimestamp?: bigint;
  memo?: string;
}

/** build MsgTransfer encode object */
export function buildMsgTransfer(params: IbcTransferParams): EncodeObject {
  return {
    typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
    value: {
      sourcePort: params.sourcePort,
      sourceChannel: params.sourceChannel,
      token: params.token,
      sender: params.sender,
      receiver: params.receiver,
      timeoutHeight: params.timeoutHeight
        ? {
            revisionNumber: params.timeoutHeight.revisionNumber.toString(),
            revisionHeight: params.timeoutHeight.revisionHeight.toString(),
          }
        : undefined,
      timeoutTimestamp: params.timeoutTimestamp?.toString() ?? '0',
      memo: params.memo ?? '',
    },
  };
}

/** estimate gas for messages */
export function estimateGas(
  _chainId: CosmosChainId,
  _address: string,
  messages: EncodeObject[],
  _memo = ''
): number {
  // simple estimation based on message count
  // real estimation would need simulation
  const baseGas = 80000;
  const perMsgGas = 20000;
  return baseGas + messages.length * perMsgGas;
}

/** calculate fee from gas */
export function calculateFee(chainId: CosmosChainId, gas: number): StdFee {
  const config = COSMOS_CHAINS[chainId];
  const gasPriceMatch = config.gasPrice.match(/^([\d.]+)(.+)$/);

  if (!gasPriceMatch) {
    throw new Error(`invalid gas price: ${config.gasPrice}`);
  }

  const [, priceStr, denom] = gasPriceMatch;
  const amount = Math.ceil(parseFloat(priceStr!) * gas);

  return {
    amount: [{ denom: denom!, amount: amount.toString() }],
    gas: gas.toString(),
  };
}
