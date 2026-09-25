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
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';
import { deriveChainAddress } from '@repo/wallet/networks/cosmos/signer';
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

/** get cosmos address from zigner insensitive data */
function getZignerAddress(
  insensitive: Record<string, unknown>,
  chainId: CosmosChainId,
): string | null {
  // zigner holds coin-118 cosmos keys; nothing it has is valid on an Ethermint chain
  if (COSMOS_CHAINS[chainId].keyAlgo === 'eth_secp256k1') {
    return null;
  }
  const addrs = insensitive['cosmosAddresses'] as
    | { chainId: string; address: string; prefix: string }[]
    | undefined;
  if (!addrs?.length) {
    return null;
  }
  const match = addrs.find(a => a.chainId === chainId);
  if (match) {
    return match.address;
  }
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
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
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
    if (effective.type === 'mnemonic') {
      return effective;
    }
    if (
      effective.type === 'zigner-zafu' &&
      getZignerAddress(effective.insensitive ?? {}, chainId)
    ) {
      return effective;
    }
  }
  for (const ki of keyInfos) {
    if (ki === effective) {
      continue;
    }
    if (ki.type === 'mnemonic') {
      return ki;
    }
    if (ki.type === 'zigner-zafu' && getZignerAddress(ki.insensitive ?? {}, chainId)) {
      return ki;
    }
  }
  return null;
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
      throw new Error(`no gas sponsor for ${COSMOS_CHAINS[chainId].name}`);
    }
    const from = expectedAddress ?? (await conduit.deriveAddress(mnemonic, accountIndex));
    feeGranter = (await conduit.requestFeeGrant(from, kind)).granter;
  }
  const res = await run(conduit, { mnemonic, accountIndex, expectedAddress, feeGranter });
  if (res.code !== 0) {
    throw new Error(res.rawLog || `broadcast failed (code ${res.code})`);
  }
  const syncBroadcast = COSMOS_CHAINS[chainId].keyAlgo === 'eth_secp256k1';
  return {
    type: 'broadcast',
    txHash: res.txHash,
    code: res.code,
    ...(syncBroadcast ? { restUrl: COSMOS_CHAINS[chainId].restEndpoint } : {}),
  };
}

/** hook for cosmos send transactions */
export const useCosmosSend = () => {
  const selectedKeyInfo = useStore(selectEffectiveKeyInfo);
  const allKeyInfos = useStore(state => state.keyRing.keyInfos);
  const { getMnemonic } = useStore(keyRingSelector);

  return useMutation({
    mutationFn: async (
      params: CosmosSendParams,
    ): Promise<CosmosTxResult | CosmosZignerSignResult> => {
      const config = COSMOS_CHAINS[params.chainId];
      const denom = params.denom ?? config.denom;
      const accountIndex = params.accountIndex ?? 0;
      const amountInBase = parseAmountToBaseUnits(
        params.amount,
        params.decimals ?? config.decimals,
      );

      const key = findCosmosKey(allKeyInfos, selectedKeyInfo, params.chainId);
      if (!key) {
        throw new Error('no cosmos-capable wallet found');
      }

      if (key.type === 'mnemonic') {
        const mnemonic = await getMnemonic(key.id);
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

      if (key.type === 'zigner-zafu') {
        // zigner path: build sign request for QR
        const insensitive = key.insensitive ?? {};
        const fromAddress = getZignerAddress(insensitive, params.chainId);
        if (!fromAddress) {
          throw new Error('no cosmos address found for zigner wallet');
        }

        const pubkey = getZignerPubkey(insensitive);
        if (!pubkey) {
          throw new Error('no cosmos public key found — reimport wallet from zigner');
        }

        const messages: EncodeObject[] = [
          buildMsgSend({
            fromAddress,
            toAddress: params.toAddress,
            amount: [{ denom, amount: amountInBase }],
          }),
        ];

        const gas = await estimateGas(params.chainId, fromAddress, messages);
        const fee = calculateFee(params.chainId, gas);

        const signRequest = await buildZignerSignDoc(
          params.chainId,
          fromAddress,
          messages,
          fee,
          params.memo ?? '',
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
    mutationFn: async (
      params: CosmosIbcTransferParams,
    ): Promise<CosmosTxResult | CosmosZignerSignResult> => {
      const config = COSMOS_CHAINS[params.sourceChainId];
      const denom = params.denom ?? config.denom;
      const accountIndex = params.accountIndex ?? 0;
      const amountInBase = parseAmountToBaseUnits(
        params.amount,
        params.decimals ?? config.decimals,
      );
      const timeoutTimestamp = BigInt(Date.now() + 10 * 60 * 1000) * 1_000_000n;

      const key = findCosmosKey(allKeyInfos, selectedKeyInfo, params.sourceChainId);
      if (!key) {
        throw new Error('no cosmos-capable wallet found');
      }

      if (key.type === 'mnemonic') {
        const mnemonic = await getMnemonic(key.id);
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

      if (key.type === 'zigner-zafu') {
        // zigner path: build sign request for QR
        const insensitive = key.insensitive ?? {};
        const fromAddress = getZignerAddress(insensitive, params.sourceChainId);
        if (!fromAddress) {
          throw new Error('no cosmos address found for zigner wallet');
        }

        const pubkey = getZignerPubkey(insensitive);
        if (!pubkey) {
          throw new Error('no cosmos public key found — reimport wallet from zigner');
        }

        const messages: EncodeObject[] = [
          buildMsgTransfer({
            sourcePort: 'transfer',
            sourceChannel: params.sourceChannel,
            token: { denom, amount: amountInBase },
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
          params.sourceChainId,
          fromAddress,
          messages,
          fee,
          params.memo ?? '',
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
      return conduitFor(chainId).deriveAddress(mnemonic, accountIndex);
    },
    enabled: !!selectedKeyInfo && selectedKeyInfo.type === 'mnemonic',
    staleTime: Infinity, // address won't change
  });
};
