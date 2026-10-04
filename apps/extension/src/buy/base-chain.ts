/**
 * Base, as the buy page uses it: the person's own address (a burner), the
 * USDC that lands there, and the few cents of eth its transactions cost.
 * Every read goes to the one rpc the person allowed (egress 'base').
 */

import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';
import type { PrivateKeyAccount } from 'viem/accounts';
import { BASE_RPC, BASE_USDC } from '../config/ramps';

let reader: PublicClient | undefined;
export const baseReader = (): PublicClient =>
  (reader ??= createPublicClient({ chain: base, transport: http(BASE_RPC) }) as PublicClient);

/** a wallet client for the person's key (signs) or just their address (reads) */
export const baseWriter = (account: PrivateKeyAccount | `0x${string}`): WalletClient =>
  createWalletClient({ account, chain: base, transport: http(BASE_RPC) });

export const usdcOf = (address: `0x${string}`): Promise<bigint> =>
  baseReader().readContract({
    address: BASE_USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });

/** what one of the person's transactions (reserve, release, send to the swap) may burn */
const GAS_PER_TX = 400_000n;

export interface GasState {
  have: bigint;
  need: bigint;
}

/** eth on the address against `txs` transactions still to send, at today's price */
export const gasState = async (address: `0x${string}`, txs = 3): Promise<GasState> => {
  const [have, price] = await Promise.all([
    baseReader().getBalance({ address }),
    baseReader().getGasPrice(),
  ]);
  return { have, need: price * GAS_PER_TX * BigInt(txs) };
};

export const enoughGas = (g: GasState): boolean => g.have >= g.need;

export class TransferReverted extends Error {
  constructor(readonly hash: `0x${string}`) {
    super("the usdc transfer didn't go through · nothing moved");
  }
}

/**
 * Send `amount` usdc from the person's key; resolves once it is in a block and
 * succeeded. `onSent` hears the hash the moment it is out. A reverted transfer
 * moved nothing and throws TransferReverted (viem's receipt doesn't throw).
 */
export const sendUsdc = async (
  account: PrivateKeyAccount,
  to: `0x${string}`,
  amount: bigint,
  onSent?: (hash: `0x${string}`) => void | Promise<void>,
): Promise<`0x${string}`> => {
  const hash = await baseWriter(account).writeContract({
    address: BASE_USDC,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
    account,
    chain: base,
  });
  await onSent?.(hash);
  const receipt = await baseReader().waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new TransferReverted(hash);
  }
  return hash;
};
