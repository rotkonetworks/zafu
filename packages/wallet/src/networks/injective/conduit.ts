/**
 * The two Injective conduit operations, end to end.
 *
 * This composes the adapter (derive -> query account -> build msg -> sign ->
 * broadcast) into exactly the two things the receive-and-shield model needs:
 *   - shieldInToPenumbra: IBC MsgTransfer of USDC from the user's inj account
 *     to their Penumbra address (which they then shield).
 *   - withdrawToExchange: bank MsgSend of USDC from the inj account to an
 *     exchange deposit address.
 *
 * The private key is derived, used, and zeroed within each call. NOTHING here
 * is wired into the UI yet - the Injective path stays disabled until the #34
 * testnet round-trip passes; these functions exist so that wiring is a call,
 * not a re-implementation.
 */

import type { Coin } from 'cosmjs-types/cosmos/base/v1beta1/coin';
import { deriveInjectiveWallet } from './derive';
import { buildSignedInjectiveTx } from './tx';
import {
  queryInjectiveAccount,
  broadcastInjectiveTx,
  buildMsgSend,
  buildMsgTransfer,
  type BroadcastResult,
} from './client';

type FetchFn = typeof fetch;

interface CommonParams {
  mnemonic: string;
  accountIndex?: number;
  /** cosmos REST/LCD base url for injective-1 */
  restUrl: string;
  fee: { amount: Coin[]; gas: string };
  chainId?: string;
  fetchFn?: FetchFn;
}

/** IBC-transfer USDC from Injective to a Penumbra address (the shield-in leg). */
export async function shieldInToPenumbra(
  p: CommonParams & {
    sourceChannel: string;
    penumbraReceiver: string;
    token: Coin;
    /** nanosecond IBC timeout; caller computes from now + a window */
    timeoutTimestamp: bigint;
    memo?: string;
  },
): Promise<BroadcastResult> {
  const w = await deriveInjectiveWallet(p.mnemonic, p.accountIndex ?? 0);
  try {
    const { accountNumber, sequence } = await queryInjectiveAccount(
      p.restUrl,
      w.address,
      p.fetchFn,
    );
    const msg = buildMsgTransfer({
      sourceChannel: p.sourceChannel,
      sender: w.address,
      receiver: p.penumbraReceiver,
      token: p.token,
      timeoutTimestamp: p.timeoutTimestamp,
      memo: p.memo,
    });
    const raw = buildSignedInjectiveTx({
      msgs: [msg],
      fee: p.fee,
      pubKey: w.publicKey,
      privKey: w.privateKey,
      accountNumber,
      sequence,
      chainId: p.chainId ?? 'injective-1',
    });
    return await broadcastInjectiveTx(p.restUrl, raw, p.fetchFn);
  } finally {
    w.privateKey.fill(0);
  }
}

/** bank-send USDC from Injective to an exchange deposit address (withdraw). */
export async function withdrawToExchange(
  p: CommonParams & { toAddress: string; amount: Coin; memo?: string },
): Promise<BroadcastResult> {
  const w = await deriveInjectiveWallet(p.mnemonic, p.accountIndex ?? 0);
  try {
    const { accountNumber, sequence } = await queryInjectiveAccount(
      p.restUrl,
      w.address,
      p.fetchFn,
    );
    const msg = buildMsgSend(w.address, p.toAddress, [p.amount]);
    const raw = buildSignedInjectiveTx({
      msgs: [msg],
      fee: p.fee,
      pubKey: w.publicKey,
      privKey: w.privateKey,
      accountNumber,
      sequence,
      chainId: p.chainId ?? 'injective-1',
      memo: p.memo,
    });
    return await broadcastInjectiveTx(p.restUrl, raw, p.fetchFn);
  } finally {
    w.privateKey.fill(0);
  }
}
