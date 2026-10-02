/**
 * cosmos signing hooks
 *
 * provides signing functionality for cosmos chains, with the selected wallet's
 * own key only (signing/cosmos-key.ts):
 * - hot: direct sign+broadcast with derived key
 * - zigner: build sign request QR, get signature from zigner, broadcast
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectSelectedKeyInfo, selectEffectiveKeyInfo, keyRingSelector } from '../state/keyring';
import {
  buildMsgSend,
  buildMsgTransfer,
  calculateFee,
  estimateGas,
  buildZignerSignDoc,
  broadcastZignerSignedTx,
  parseAmountToBaseUnits,
} from '@repo/wallet/networks/cosmos/signer';
import type { ZignerSignRequest, EncodeObject } from '@repo/wallet/networks/cosmos/signer';
import { encodeCosmosSignRequest } from '@repo/wallet/networks/cosmos/airgap';
import { getCosmosChain, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { cosmosKeyFor, noCosmosKey } from '../signing/cosmos-key';
import { conduitFor, type TxKind } from '@repo/wallet/networks/transparent/conduit';

/** send parameters */
export interface CosmosSendParams {
  chainId: CosmosChainId;
  toAddress: string;
  amount: string;
  denom?: string;
  memo?: string;
  accountIndex?: number;
  /** decimals of `denom`; defaults to the chain's native asset */
  decimals?: number;
  /** the address the form checked balances against (re-derived before signing) */
  expectedAddress?: string;
  /** pay the fee through the chain's gas sponsor (x/feegrant) */
  sponsored?: boolean;
}

/** ibc transfer parameters */
export interface CosmosIbcTransferParams {
  sourceChainId: CosmosChainId;
  destChainId: string;
  sourceChannel: string;
  toAddress: string;
  amount: string;
  denom?: string;
  memo?: string;
  accountIndex?: number;
  /** decimals of `denom`; defaults to the chain's native asset */
  decimals?: number;
  /** the address the form checked balances against (re-derived before signing) */
  expectedAddress?: string;
  /** pay the fee through the chain's gas sponsor (x/feegrant) */
  sponsored?: boolean;
}

/** result from mnemonic sign+broadcast */
export interface CosmosTxResult {
  type: 'broadcast';
  txHash: string;
  code: number;
  /**
   * Set when the tx was only accepted into the mempool (sync broadcast): the
   * LCD to confirm inclusion against. Unset = already included in a block.
   */
  restUrl?: string;
}

/** result from zigner sign request (needs QR flow before broadcast) */
export interface CosmosZignerSignResult {
  type: 'zigner';
  signRequestQr: string;
  signRequest: ZignerSignRequest;
  chainId: CosmosChainId;
  pubkey: Uint8Array;
}

/** get cosmos pubkey from zigner insensitive data (hex-encoded compressed secp256k1) */
function getZignerPubkey(insensitive: Record<string, unknown>): Uint8Array | null {
  const hex = insensitive['cosmosPublicKey'] as string | undefined;
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Sign + broadcast with the vault's mnemonic through the chain's conduit, via
 * the gas sponsor when asked. A rejected tx throws: code 0 is the only success.
 */
async function broadcastWithMnemonic(
  chainId: CosmosChainId,
  mnemonic: string,
  accountIndex: number,
  kind: TxKind,
  sponsored: boolean | undefined,
  expectedAddress: string | undefined,
  run: (
    conduit: ReturnType<typeof conduitFor>,
    signer: {
      mnemonic: string;
      accountIndex: number;
      expectedAddress?: string;
      feeGranter?: string;
    },
  ) => Promise<{ txHash: string; code: number; rawLog: string }>,
): Promise<CosmosTxResult> {
  const conduit = conduitFor(chainId);
  let feeGranter: string | undefined;
  if (sponsored) {
    if (!conduit.requestFeeGrant) {
      throw new Error(`no gas sponsor for ${getCosmosChain(chainId).name}`);
    }
    const from = expectedAddress ?? (await conduit.deriveAddress(mnemonic, accountIndex));
    feeGranter = (await conduit.requestFeeGrant(from, kind)).granter;
  }
  const res = await run(conduit, { mnemonic, accountIndex, expectedAddress, feeGranter });
  if (res.code !== 0) {
    throw new Error(res.rawLog || `broadcast failed (code ${res.code})`);
  }
  const syncBroadcast = getCosmosChain(chainId).keyAlgo === 'eth_secp256k1';
  return {
    type: 'broadcast',
    txHash: res.txHash,
    code: res.code,
    ...(syncBroadcast ? { restUrl: getCosmosChain(chainId).restEndpoint } : {}),
  };
}

interface KeyFacts {
  id: string;
  type: string;
  insensitive: Record<string, unknown>;
}
type GetMnemonic = (id: string) => Promise<string>;

/** The zigner sign request for `messages`, as a QR for the device. */
async function zignerSignRequest(
  chainId: CosmosChainId,
  key: { key: KeyFacts; address: string },
  accountIndex: number,
  messages: EncodeObject[],
  gas: number | undefined,
  memo: string | undefined,
): Promise<CosmosZignerSignResult> {
  const pubkey = getZignerPubkey(key.key.insensitive);
  if (!pubkey) {
    throw new Error('no cosmos public key found - reimport wallet from zigner');
  }
  const fee = calculateFee(chainId, gas ?? (await estimateGas(chainId, key.address, messages)));
  const signRequest = await buildZignerSignDoc(chainId, key.address, messages, fee, memo ?? '');
  return {
    type: 'zigner',
    signRequestQr: encodeCosmosSignRequest(accountIndex, chainId, signRequest.signDocBytes),
    signRequest,
    chainId,
    pubkey,
  };
}

/** The selected wallet's own cosmos key, or a calm refusal. Never another wallet's. */
const ownCosmosKey = (key: KeyFacts | undefined, chainId: CosmosChainId) => {
  const own = cosmosKeyFor(key, chainId);
  if (!own) {
    throw new Error(noCosmosKey(chainId));
  }
  return own;
};

export async function cosmosSend(
  params: CosmosSendParams,
  selected: KeyFacts | undefined,
  getMnemonic: GetMnemonic,
): Promise<CosmosTxResult | CosmosZignerSignResult> {
  const config = getCosmosChain(params.chainId);
  const denom = params.denom ?? config.denom;
  const accountIndex = params.accountIndex ?? 0;
  const amountInBase = parseAmountToBaseUnits(params.amount, params.decimals ?? config.decimals);
  const own = ownCosmosKey(selected, params.chainId);

  if (own.signer === 'hot') {
    const mnemonic = await getMnemonic(own.key.id);
    return broadcastWithMnemonic(
      params.chainId,
      mnemonic,
      accountIndex,
      'send',
      params.sponsored,
      params.expectedAddress,
      (conduit, signer) =>
        conduit.send({
          ...signer,
          to: params.toAddress,
          coin: { denom, amount: amountInBase },
          memo: params.memo,
        }),
    );
  }
  const messages = [
    buildMsgSend({
      fromAddress: own.address,
      toAddress: params.toAddress,
      amount: [{ denom, amount: amountInBase }],
    }),
  ];
  return zignerSignRequest(params.chainId, own, accountIndex, messages, undefined, params.memo);
}

export async function cosmosIbcTransfer(
  params: CosmosIbcTransferParams,
  selected: KeyFacts | undefined,
  getMnemonic: GetMnemonic,
): Promise<CosmosTxResult | CosmosZignerSignResult> {
  const config = getCosmosChain(params.sourceChainId);
  const denom = params.denom ?? config.denom;
  const accountIndex = params.accountIndex ?? 0;
  const amountInBase = parseAmountToBaseUnits(params.amount, params.decimals ?? config.decimals);
  const timeoutTimestamp = BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n;
  const own = ownCosmosKey(selected, params.sourceChainId);

  if (own.signer === 'hot') {
    const mnemonic = await getMnemonic(own.key.id);
    return broadcastWithMnemonic(
      params.sourceChainId,
      mnemonic,
      accountIndex,
      'ibc',
      params.sponsored,
      params.expectedAddress,
      (conduit, signer) =>
        conduit.ibcTransfer({
          ...signer,
          sourceChannel: params.sourceChannel,
          receiver: params.toAddress,
          coin: { denom, amount: amountInBase },
          timeoutTimestamp,
          memo: params.memo,
        }),
    );
  }
  const messages = [
    buildMsgTransfer({
      sourcePort: 'transfer',
      sourceChannel: params.sourceChannel,
      token: { denom, amount: amountInBase },
      sender: own.address,
      receiver: params.toAddress,
      timeoutTimestamp,
      memo: params.memo,
    }),
  ];
  // for IBC, use a fixed higher gas estimate
  return zignerSignRequest(params.sourceChainId, own, accountIndex, messages, 200000, params.memo);
}

/** hook for cosmos send transactions */
export const useCosmosSend = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);
  return useMutation({
    mutationFn: (params: CosmosSendParams) => cosmosSend(params, selectedKeyInfo, getMnemonic),
  });
};

/** hook for IBC transfers */
export const useCosmosIbcTransfer = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);
  return useMutation({
    mutationFn: (params: CosmosIbcTransferParams) =>
      cosmosIbcTransfer(params, selectedKeyInfo, getMnemonic),
  });
};

/** hook to broadcast a zigner-signed cosmos transaction */
export const useCosmosZignerBroadcast = () => {
  return useMutation({
    mutationFn: async (params: {
      chainId: CosmosChainId;
      signRequest: ZignerSignRequest;
      signature: Uint8Array;
      pubkey: Uint8Array;
    }) => {
      const result = await broadcastZignerSignedTx(
        params.chainId,
        params.signRequest,
        params.signature,
        params.pubkey,
      );

      return {
        txHash: result.transactionHash,
        code: result.code,
        gasUsed: result.gasUsed,
        gasWanted: result.gasWanted,
      };
    },
  });
};

/** hook to get cosmos address for a chain */
export const useCosmosAddress = (chainId: CosmosChainId, accountIndex = 0) => {
  const selectedKeyInfo = useStore(selectSelectedKeyInfo);
  const { getMnemonic } = useStore(keyRingSelector);

  return useQuery({
    queryKey: ['cosmosAddress', chainId, selectedKeyInfo?.id, accountIndex],
    queryFn: async () => {
      if (!selectedKeyInfo) {
        throw new Error('no wallet selected');
      }
      if (selectedKeyInfo.type !== 'mnemonic') {
        return null; // watch-only wallets don't have cosmos addresses
      }

      const mnemonic = await getMnemonic(selectedKeyInfo.id);
      return conduitFor(chainId).deriveAddress(mnemonic, accountIndex);
    },
    enabled: !!selectedKeyInfo && selectedKeyInfo.type === 'mnemonic',
    staleTime: Infinity, // address won't change
  });
};
