/**
 * cosmos signing hooks
 *
 * provides signing functionality for cosmos chains.
 * supports two wallet types:
 * - mnemonic: direct sign+broadcast with derived key
 * - zigner-zafu: build sign request QR, get signature from zigner, broadcast
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useStore } from '../state';
import { selectSelectedKeyInfo, selectEffectiveKeyInfo, keyRingSelector } from '../state/keyring';
import {
  signAndBroadcast,
  createSigningClient,
  buildMsgSend,
  buildMsgTransfer,
  calculateFee,
  estimateGas,
  buildZignerSignDoc,
  broadcastZignerSignedTx,
} from '@repo/wallet/networks/cosmos/signer';
import type { ZignerSignRequest, EncodeObject } from '@repo/wallet/networks/cosmos/signer';
import { encodeCosmosSignRequest } from '@repo/wallet/networks/cosmos/airgap';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { deriveChainAddress } from '@repo/wallet/networks/cosmos/signer';

/** send parameters */
export interface CosmosSendParams {
  chainId: CosmosChainId;
  toAddress: string;
  amount: string;
  denom?: string;
  memo?: string;
  accountIndex?: number;
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
}

/** result from mnemonic sign+broadcast */
interface CosmosTxResult {
  type: 'broadcast';
  txHash: string;
  code: number;
  gasUsed: bigint;
  gasWanted: bigint;
}

/** result from zigner sign request (needs QR flow before broadcast) */
export interface CosmosZignerSignResult {
  type: 'zigner';
  signRequestQr: string;
  signRequest: ZignerSignRequest;
  chainId: CosmosChainId;
  pubkey: Uint8Array;
}

/** get cosmos address from zigner insensitive data */
function getZignerAddress(
  insensitive: Record<string, unknown>,
  chainId: CosmosChainId,
): string | null {
  const addrs = insensitive['cosmosAddresses'] as
    { chainId: string; address: string; prefix: string }[] | undefined;
  if (!addrs?.length) return null;
  const match = addrs.find(a => a.chainId === chainId);
  if (match) return match.address;
  // derive from any stored address using bech32 prefix conversion
  try {
    return deriveChainAddress(addrs[0]!.address, chainId);
  } catch {
    return null;
  }
}

/** get cosmos pubkey from zigner insensitive data (hex-encoded compressed secp256k1) */
function getZignerPubkey(insensitive: Record<string, unknown>): Uint8Array | null {
  const hex = insensitive['cosmosPublicKey'] as string | undefined;
  if (!hex) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** find a keyInfo with cosmos capability — effective first, then any wallet */
function findCosmosKey(
  keyInfos: { id: string; type: string; insensitive: Record<string, unknown> }[],
  effective: { id: string; type: string; insensitive: Record<string, unknown> } | undefined,
  chainId: CosmosChainId,
) {
  if (effective) {
    if (effective.type === 'mnemonic') return effective;
    if (effective.type === 'zigner-zafu' && getZignerAddress(effective.insensitive ?? {}, chainId)) return effective;
  }
  for (const ki of keyInfos) {
    if (ki === effective) continue;
    if (ki.type === 'mnemonic') return ki;
    if (ki.type === 'zigner-zafu' && getZignerAddress(ki.insensitive ?? {}, chainId)) return ki;
  }
  return null;
}

/** hook for cosmos send transactions */
export const useCosmosSend = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const allKeyInfos = useStore(state => state.keyRing.keyInfos);
  const { getMnemonic } = useStore(keyRingSelector);

  return useMutation({
    mutationFn: async (params: CosmosSendParams): Promise<CosmosTxResult | CosmosZignerSignResult> => {
      const config = COSMOS_CHAINS[params.chainId];
      const denom = params.denom ?? config.denom;
      const accountIndex = params.accountIndex ?? 0;
      const amountInBase = Math.floor(parseFloat(params.amount) * Math.pow(10, config.decimals));

      const key = findCosmosKey(allKeyInfos, selectedKeyInfo, params.chainId);
      if (!key) throw new Error('no cosmos-capable wallet found');

      if (key.type === 'mnemonic') {
        // mnemonic path: direct sign+broadcast
        const mnemonic = await getMnemonic(key.id);
        const { address: fromAddress } = await createSigningClient(
          params.chainId, mnemonic, accountIndex,
        ).then(r => ({ address: r.address }));

        const messages = [
          buildMsgSend({
            fromAddress,
            toAddress: params.toAddress,
            amount: [{ denom, amount: amountInBase.toString() }],
          }),
        ];

        const gas = await estimateGas(params.chainId, fromAddress, messages);
        const fee = calculateFee(params.chainId, gas);

        const result = await signAndBroadcast(
          params.chainId, mnemonic, messages, fee, params.memo ?? '', accountIndex,
        );

        return {
          type: 'broadcast',
          txHash: result.transactionHash,
          code: result.code,
          gasUsed: result.gasUsed,
          gasWanted: result.gasWanted,
        };
      }

      if (key.type === 'zigner-zafu') {
        // zigner path: build sign request for QR
        const insensitive = key.insensitive ?? {};
        const fromAddress = getZignerAddress(insensitive, params.chainId);
        if (!fromAddress) throw new Error('no cosmos address found for zigner wallet');

        const pubkey = getZignerPubkey(insensitive);
        if (!pubkey) throw new Error('no cosmos public key found — reimport wallet from zigner');

        const messages: EncodeObject[] = [
          buildMsgSend({
            fromAddress,
            toAddress: params.toAddress,
            amount: [{ denom, amount: amountInBase.toString() }],
          }),
        ];

        const gas = await estimateGas(params.chainId, fromAddress, messages);
        const fee = calculateFee(params.chainId, gas);

        const signRequest = await buildZignerSignDoc(
          params.chainId, fromAddress, messages, fee, params.memo ?? '',
        );

        const signRequestQr = encodeCosmosSignRequest(
          accountIndex,
          params.chainId,
          signRequest.signDocBytes,
        );

        return {
          type: 'zigner',
          signRequestQr,
          signRequest,
          chainId: params.chainId,
          pubkey,
        };
      }

      throw new Error('unsupported wallet type for cosmos signing');
    },
  });
};

/** hook for IBC transfers */
export const useCosmosIbcTransfer = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const allKeyInfos = useStore(state => state.keyRing.keyInfos);
  const { getMnemonic } = useStore(keyRingSelector);

  return useMutation({
    mutationFn: async (params: CosmosIbcTransferParams): Promise<CosmosTxResult | CosmosZignerSignResult> => {
      const config = COSMOS_CHAINS[params.sourceChainId];
      const denom = params.denom ?? config.denom;
      const accountIndex = params.accountIndex ?? 0;
      const amountInBase = Math.floor(parseFloat(params.amount) * Math.pow(10, config.decimals));
      const timeoutTimestamp = BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n;

      const key = findCosmosKey(allKeyInfos, selectedKeyInfo, params.sourceChainId);
      if (!key) throw new Error('no cosmos-capable wallet found');

      if (key.type === 'mnemonic') {
        // mnemonic path: direct sign+broadcast
        const mnemonic = await getMnemonic(key.id);
        const { client, address: fromAddress } = await createSigningClient(
          params.sourceChainId, mnemonic, accountIndex,
        );

        const messages = [
          buildMsgTransfer({
            sourcePort: 'transfer',
            sourceChannel: params.sourceChannel,
            token: { denom, amount: amountInBase.toString() },
            sender: fromAddress,
            receiver: params.toAddress,
            timeoutTimestamp,
            memo: params.memo,
          }),
        ];

        try {
          const result = await client.signAndBroadcast(fromAddress, messages, 'auto', params.memo ?? '');
          return {
            type: 'broadcast',
            txHash: result.transactionHash,
            code: result.code,
            gasUsed: result.gasUsed,
            gasWanted: result.gasWanted,
          };
        } finally {
          client.disconnect();
        }
      }

      if (key.type === 'zigner-zafu') {
        // zigner path: build sign request for QR
        const insensitive = key.insensitive ?? {};
        const fromAddress = getZignerAddress(insensitive, params.sourceChainId);
        if (!fromAddress) throw new Error('no cosmos address found for zigner wallet');

        const pubkey = getZignerPubkey(insensitive);
        if (!pubkey) throw new Error('no cosmos public key found — reimport wallet from zigner');

        const messages: EncodeObject[] = [
          buildMsgTransfer({
            sourcePort: 'transfer',
            sourceChannel: params.sourceChannel,
            token: { denom, amount: amountInBase.toString() },
            sender: fromAddress,
            receiver: params.toAddress,
            timeoutTimestamp,
            memo: params.memo,
          }),
        ];

        // for IBC, use higher gas estimate
        const gas = 200000;
        const fee = calculateFee(params.sourceChainId, gas);

        const signRequest = await buildZignerSignDoc(
          params.sourceChainId, fromAddress, messages, fee, params.memo ?? '',
        );

        const signRequestQr = encodeCosmosSignRequest(
          accountIndex,
          params.sourceChainId,
          signRequest.signDocBytes,
        );

        return {
          type: 'zigner',
          signRequestQr,
          signRequest,
          chainId: params.sourceChainId,
          pubkey,
        };
      }

      throw new Error('unsupported wallet type for cosmos signing');
    },
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
      const { address } = await createSigningClient(chainId, mnemonic, accountIndex);
      return address;
    },
    enabled: !!selectedKeyInfo && selectedKeyInfo.type === 'mnemonic',
    staleTime: Infinity, // address won't change
  });
};
