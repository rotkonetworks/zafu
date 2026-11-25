/**
 * The evm send path as plain functions: talk to a node, complete a site's
 * transaction from it, sign, broadcast. Nothing here holds a key past one
 * call: withDappAccount derives it, lends it, and zeroes it.
 */

import { bytesToHex, isAddress, isHex, type Hex, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deriveEthWalletAtPath } from '@repo/wallet/networks/ethereum/derive';
import { DAPP_EVM_PATH } from './chains';

/** an EIP-1193 error: the code is what a site's wallet library reads */
export class EvmError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const REJECTED = 4001;
export const UNAUTHORIZED = 4100;
export const UNSUPPORTED = 4200;
export const UNKNOWN_CHAIN = 4902;
const INVALID_PARAMS = -32602;

export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** JSON-RPC over the egress-guarded fetch; a node's own error keeps its code */
export const rpcAt =
  (url: string): Rpc =>
  async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await res.json()) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (json.error) {
      throw new EvmError(json.error.code ?? -32603, json.error.message ?? 'the node refused this');
    }
    return json.result;
  };

/** eth_sendTransaction's parameter, as a site sends it (hex quantities) */
export interface TxParams {
  from?: string;
  to?: string | null;
  value?: string;
  data?: string;
  gas?: string;
  gasPrice?: string;
  nonce?: string;
  chainId?: string | number;
}

export interface LegacyTx {
  chainId: number;
  to?: Hex;
  value: bigint;
  data?: Hex;
  gas: bigint;
  gasPrice: bigint;
  nonce: number;
}

const quantity = (raw: unknown, name: string): bigint => {
  try {
    return BigInt(raw as string);
  } catch {
    throw new EvmError(INVALID_PARAMS, `${name} isn't a number zafu can read`);
  }
};

/**
 * The site's transaction, with what it left out (nonce, gas, gas price) asked
 * of the node. Legacy pricing: bnb smart chain takes it, and it is one number
 * to show. A `from` other than the person's address is refused.
 */
export const fillTx = async (
  rpc: Rpc,
  chainId: number,
  from: Hex,
  p: TxParams,
): Promise<LegacyTx> => {
  if (p.from !== undefined && p.from.toLowerCase() !== from.toLowerCase()) {
    throw new EvmError(
      UNAUTHORIZED,
      'this transaction names an address zafu did not give this site',
    );
  }
  // signed for the site's current chain: a request naming another would be
  // approved here as one chain and land on another
  if (p.chainId !== undefined && quantity(String(p.chainId), 'chain id') !== BigInt(chainId)) {
    throw new EvmError(INVALID_PARAMS, "this transaction names another chain than the site's");
  }
  if (p.to != null && !isAddress(p.to, { strict: false })) {
    throw new EvmError(INVALID_PARAMS, "the recipient isn't an address");
  }
  if (p.data !== undefined && (!isHex(p.data) || p.data.length % 2 !== 0)) {
    throw new EvmError(INVALID_PARAMS, "the transaction data isn't hex");
  }
  // narrowed by isAddress and isHex above
  const to = p.to ?? undefined;
  const data = p.data;
  const value = quantity(p.value ?? '0x0', 'value');
  const call = { from, to, value: `0x${value.toString(16)}`, data };
  const [nonce, gas, gasPrice] = await Promise.all([
    p.nonce ?? rpc('eth_getTransactionCount', [from, 'pending']),
    p.gas ?? rpc('eth_estimateGas', [call]),
    p.gasPrice ?? rpc('eth_gasPrice', []),
  ]);
  return {
    chainId,
    to,
    value,
    data,
    gas: quantity(gas, 'gas'),
    gasPrice: quantity(gasPrice, 'gas price'),
    nonce: Number(quantity(nonce, 'nonce')),
  };
};

export type EvmAccount = Pick<PrivateKeyAccount, 'address' | 'signTransaction' | 'signMessage'>;

/** run `fn` with the seed's dapp key (chains DAPP_EVM_PATH), then zero the key bytes */
export const withDappAccount = async <T>(
  mnemonic: string,
  fn: (account: EvmAccount) => Promise<T>,
): Promise<T> => {
  const w = deriveEthWalletAtPath(mnemonic, DAPP_EVM_PATH);
  try {
    return await fn(privateKeyToAccount(bytesToHex(w.privateKey)));
  } finally {
    w.privateKey.fill(0);
  }
};

/** sign the filled transaction and hand it to the node; the hash is all that comes back */
export const signAndSend = async (rpc: Rpc, account: EvmAccount, tx: LegacyTx): Promise<Hex> =>
  (await rpc('eth_sendRawTransaction', [
    await account.signTransaction({ type: 'legacy', ...tx }),
  ])) as Hex;

/** a LegacyTx as session storage keeps it: bigints as decimal strings */
export type StoredTx = Omit<LegacyTx, 'value' | 'gas' | 'gasPrice'> & {
  value: string;
  gas: string;
  gasPrice: string;
};

export const storeTx = (tx: LegacyTx): StoredTx => ({
  ...tx,
  value: tx.value.toString(),
  gas: tx.gas.toString(),
  gasPrice: tx.gasPrice.toString(),
});
