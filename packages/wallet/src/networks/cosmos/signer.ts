/**
 * cosmos signer - key derivation and transaction signing
 *
 * uses @cosmjs for:
 * - HD wallet derivation (m/44'/118'/0'/0/n)
 * - amino and direct signing
 * - transaction broadcast
 */

import { Secp256k1HdWallet, makeCosmoshubPath } from '@cosmjs/amino';
import { makeSignDoc as makeAminoSignDoc, serializeSignDoc } from '@cosmjs/amino';
import type { AminoMsg, StdSignDoc } from '@cosmjs/amino';
import { SigningStargateClient, StargateClient, GasPrice } from '@cosmjs/stargate';
import { fromBech32, toBech32, toBase64 } from '@cosmjs/encoding';
import { encodePubkey, makeAuthInfoBytes } from '@cosmjs/proto-signing';
import type { Coin, StdFee } from '@cosmjs/amino';
import type { DeliverTxResponse } from '@cosmjs/stargate';
import { COSMOS_CHAINS, type CosmosChainId } from './chains';

/** encode object for cosmos messages */
export interface EncodeObject {
  typeUrl: string;
  value: unknown;
}

/**
 * Cosmos HD path: m/44'/118'/0'/0/{accountIndex}
 *
 * Standard cosmoshub path per SLIP-044. accountIndex is the BIP44 address_index.
 * All callers currently use accountIndex=0 only; no users have derived addresses
 * with accountIndex>0, so there is no migration concern.
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

/**
 * parse a decimal amount string into integer base units.
 * avoids floating-point: splits on '.', pads/truncates fractional part,
 * concatenates, and parses as bigint.
 *
 * e.g. parseAmountToBaseUnits("0.3", 6) => "300000"
 *      parseAmountToBaseUnits("1.23", 6) => "1230000"
 *      parseAmountToBaseUnits("100", 6)  => "100000000"
 */
export function parseAmountToBaseUnits(amount: string, decimals: number): string {
  const [whole = '0', frac = ''] = amount.split('.');
  const padded = frac.slice(0, decimals).padEnd(decimals, '0');
  const raw = BigInt(whole + padded);
  return raw.toString();
}

/** estimate gas for messages */
export function estimateGas(
  _chainId: CosmosChainId,
  _address: string,
  messages: EncodeObject[],
  _memo = ''
): number {
  // simple estimation based on message type
  // real estimation would need simulation
  const gasPerMsg = messages.map(m => {
    if (m.typeUrl === '/ibc.applications.transfer.v1.MsgTransfer') return 200000;
    return 150000; // MsgSend and others
  });
  return gasPerMsg.reduce((sum, g) => sum + g, 0);
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

// ============================================================================
// Zigner (airgap) signing support
// ============================================================================

/** convert proto EncodeObject to amino AminoMsg */
function toAminoMsg(msg: EncodeObject): AminoMsg {
  const v = msg.value as Record<string, unknown>;

  if (msg.typeUrl === '/cosmos.bank.v1beta1.MsgSend') {
    return {
      type: 'cosmos-sdk/MsgSend',
      value: {
        from_address: v['fromAddress'],
        to_address: v['toAddress'],
        amount: v['amount'],
      },
    };
  }

  if (msg.typeUrl === '/ibc.applications.transfer.v1.MsgTransfer') {
    return {
      type: 'cosmos-sdk/MsgTransfer',
      value: {
        source_port: v['sourcePort'],
        source_channel: v['sourceChannel'],
        token: v['token'],
        sender: v['sender'],
        receiver: v['receiver'],
        timeout_height: v['timeoutHeight'] ?? { revision_number: '0', revision_height: '0' },
        timeout_timestamp: v['timeoutTimestamp'] ?? '0',
        memo: v['memo'] ?? '',
      },
    };
  }

  throw new Error(`unsupported message type for amino: ${msg.typeUrl}`);
}

/** result from building a zigner sign request */
export interface ZignerSignRequest {
  /** amino SignDoc as canonical JSON bytes */
  signDocBytes: Uint8Array;
  /** amino SignDoc object (for reference) */
  signDoc: StdSignDoc;
  /** fee used */
  fee: StdFee;
  /** account number from chain */
  accountNumber: number;
  /** sequence from chain */
  sequence: number;
  /** the proto messages (for TxRaw reconstruction) */
  messages: EncodeObject[];
  /** memo */
  memo: string;
}

/**
 * build amino SignDoc for zigner signing (no mnemonic needed)
 *
 * queries account info from chain, builds the SignDoc, and serializes it.
 * the serialized bytes are what Zigner signs: SHA256(signDocBytes).
 */
export async function buildZignerSignDoc(
  chainId: CosmosChainId,
  fromAddress: string,
  messages: EncodeObject[],
  fee: StdFee,
  memo = '',
): Promise<ZignerSignRequest> {
  const config = COSMOS_CHAINS[chainId];

  // query account info from chain (read-only client)
  const client = await StargateClient.connect(config.rpcEndpoint);
  try {
    const account = await client.getAccount(fromAddress);
    if (!account) {
      throw new Error(`account not found on chain: ${fromAddress}`);
    }

    // convert messages to amino format
    const aminoMsgs = messages.map(toAminoMsg);

    // build the amino SignDoc
    const signDoc = makeAminoSignDoc(
      aminoMsgs,
      fee,
      config.chainId,
      memo,
      account.accountNumber,
      account.sequence,
    );

    // serialize to canonical JSON bytes (this is what gets signed)
    const signDocBytes = serializeSignDoc(signDoc);

    return {
      signDocBytes,
      signDoc,
      fee,
      accountNumber: account.accountNumber,
      sequence: account.sequence,
      messages,
      memo,
    };
  } finally {
    client.disconnect();
  }
}

/**
 * broadcast a transaction signed by Zigner
 *
 * reconstructs TxRaw from the amino SignDoc + signature + pubkey and broadcasts.
 */
export async function broadcastZignerSignedTx(
  chainId: CosmosChainId,
  signRequest: ZignerSignRequest,
  signature: Uint8Array,
  pubkey: Uint8Array,
): Promise<DeliverTxResponse> {
  const config = COSMOS_CHAINS[chainId];

  // build amino-style pubkey for proto encoding
  const aminoPubkey = {
    type: 'tendermint/PubKeySecp256k1',
    value: toBase64(pubkey),
  };
  const pubkeyAny = encodePubkey(aminoPubkey);

  // dynamic imports for proto types (transitive deps of @cosmjs/stargate)
  const { TxRaw } = await import('cosmjs-types/cosmos/tx/v1beta1/tx');
  const { SignMode } = await import('cosmjs-types/cosmos/tx/signing/v1beta1/signing');

  // build AuthInfo bytes
  const authInfoBytes = makeAuthInfoBytes(
    [{ pubkey: pubkeyAny, sequence: signRequest.sequence }],
    signRequest.fee.amount,
    parseInt(signRequest.fee.gas),
    signRequest.fee.granter,
    signRequest.fee.payer,
    SignMode.SIGN_MODE_LEGACY_AMINO_JSON,
  );

  // build TxBody from the proto messages
  // use defaultRegistryTypes which includes MsgSend, MsgTransfer, etc.
  const { Registry: CosmosRegistry } = await import('@cosmjs/proto-signing');
  const { defaultRegistryTypes } = await import('@cosmjs/stargate');
  const registry = new CosmosRegistry(defaultRegistryTypes);
  const txBodyBytes = registry.encodeTxBody({
    messages: signRequest.messages,
    memo: signRequest.memo,
  });

  // construct TxRaw
  const txRaw = TxRaw.fromPartial({
    bodyBytes: txBodyBytes,
    authInfoBytes,
    signatures: [signature],
  });

  const txBytes = TxRaw.encode(txRaw).finish();

  // broadcast via read-only client
  const client = await StargateClient.connect(config.rpcEndpoint);
  try {
    return await client.broadcastTx(txBytes);
  } finally {
    client.disconnect();
  }
}
