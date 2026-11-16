/**
 * Moving USDC on Hyperliquid, as plain functions: which action a choice
 * means, what stops it, how it is signed, and what a posted action's answer
 * means for the next step. The screen (hyperliquid-send.tsx) only draws these.
 */

import { HYPERLIQUID_WITHDRAW_FEE } from '@repo/wallet/networks/hyperliquid/api';
import {
  buildHyperliquidAction,
  isHyperliquidAddress,
  microToUsdc,
  signHyperliquidAction,
  usdcToMicro,
  type HyperliquidBalances,
  type HyperliquidMove,
  type HyperliquidOutcome,
  type SignedHyperliquidAction,
} from '@repo/wallet/networks/hyperliquid/client';
import { deriveHyperliquidWallet } from '@repo/wallet/networks/hyperliquid/derive';

export type MoveMode = 'send' | 'withdraw';
export type MoveFrom = keyof HyperliquidBalances;

/** each action as review words it; the fee is Hyperliquid's own, from its docs */
export const MOVES: Record<
  HyperliquidMove,
  { from: MoveFrom; action: string; arrives: string; lead: string; confirm: string; fee?: bigint }
> = {
  usdSend: {
    from: 'perp',
    action: 'send from perp account',
    arrives: 'hyperliquid',
    lead: 'you send',
    confirm: 'send',
  },
  spotSend: {
    from: 'spot',
    action: 'send from spot account',
    arrives: 'hyperliquid',
    lead: 'you send',
    confirm: 'send',
  },
  withdraw3: {
    from: 'perp',
    action: 'withdraw from perp account',
    arrives: 'arbitrum',
    lead: 'you withdraw',
    confirm: 'withdraw',
    fee: HYPERLIQUID_WITHDRAW_FEE,
  },
};

/** a withdrawal always leaves the perp account; a send leaves the one chosen */
export const moveOf = (mode: MoveMode, from: MoveFrom): HyperliquidMove =>
  mode === 'withdraw' ? 'withdraw3' : from === 'spot' ? 'spotSend' : 'usdSend';

const AMOUNT = /^(\d+\.?\d{0,6}|\.\d{1,6})$/;

/**
 * The amount in millionths once the move may be reviewed, or what stops it
 * and the field that says so.
 * Empty fields stop it silently: there is nothing to say yet.
 */
export const checkMove = (m: {
  move: HyperliquidMove;
  to: string;
  amount: string;
  balances: HyperliquidBalances | undefined;
  own: string | undefined;
}): { micro?: bigint; problem?: string; field?: 'to' | 'amount' } => {
  const to = m.to.trim();
  const { from, fee } = MOVES[m.move];
  if (to && !isHyperliquidAddress(to)) {
    return { field: 'to', problem: 'that is not a 0x address · please check it' };
  }
  if (fee === undefined && to && to.toLowerCase() === m.own) {
    return { field: 'to', problem: 'that is this account · it already has these funds' };
  }
  if (!m.amount) {
    return {};
  }
  if (!AMOUNT.test(m.amount)) {
    return { field: 'amount', problem: 'a number with up to six decimals, please' };
  }
  const micro = usdcToMicro(m.amount);
  if (m.balances && micro > m.balances[from]) {
    return {
      field: 'amount',
      problem: `the ${from} account has ${microToUsdc(m.balances[from])} usdc to move`,
    };
  }
  if (fee !== undefined && micro <= fee) {
    return {
      field: 'amount',
      problem: `a withdrawal has to be more than the ${microToUsdc(fee)} usdc fee`,
    };
  }
  return to && micro > 0n && m.balances ? { micro } : {};
};

/**
 * Sign one move with the wallet's own key, zeroed before this returns. The
 * key is re-derived and must be the address the balances were read for, so a
 * changed path or wallet can never sign for another account.
 */
export const signMove = (m: {
  mnemonic: string;
  path: string;
  address: string;
  move: HyperliquidMove;
  to: string;
  micro: bigint;
  now: number;
}): SignedHyperliquidAction => {
  const wallet = deriveHyperliquidWallet(m.mnemonic, m.path);
  try {
    if (wallet.address !== m.address) {
      throw new Error('the key no longer matches this address');
    }
    return signHyperliquidAction(
      wallet.privateKey,
      buildHyperliquidAction(m.move, m.to.trim(), m.micro, m.now),
    );
  } finally {
    wallet.privateKey.fill(0);
  }
};

/**
 * Where an answer leaves the person:
 *  - `refused`: Hyperliquid turned it down, nothing moved, a new try is safe;
 *  - `unclear`: no answer either way. The same signed action may be posted
 *    again (its nonce is taken once, so it cannot pay twice);
 *  - `check`: a refusal AFTER an unclear try. The first try may be what spent
 *    the nonce, so the balance is the only thing that can say.
 */
export type MoveStage = 'done' | 'refused' | 'unclear' | 'check';

export const stageAfter = (outcome: HyperliquidOutcome['outcome'], retried: boolean): MoveStage =>
  outcome === 'ok' ? 'done' : outcome === 'unclear' ? 'unclear' : retried ? 'check' : 'refused';
