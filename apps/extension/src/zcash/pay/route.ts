/**
 * How a payment to a transparent recipient (t1/t3, or a ZIP 320 tex that
 * takes transparent inputs only) leaves the wallet: from the shielded pool
 * as usual (a tex goes through a fresh address of its own, ./via-fresh), or
 * from the public balance when the person picks it, from one address that
 * covers it alone. Never several: spending two addresses in one transaction
 * tells everyone they are one wallet.
 */

import {
  depositFeeZat,
  type DepositPlan,
  type DepositRequest,
} from '../../workers/transparent-deposit';

export interface TAddress {
  index: number;
  address: string;
}

export interface TPayment {
  to: string;
  amountZat: string;
  mainnet: boolean;
}

/**
 * A transparent payment as reviewed: from one of the pocket's addresses at
 * its planned fee, or by moving `move` zatoshi from the shielded pool to a
 * fresh address that then pays with one input at `fee`.
 */
export type PayRoute = { from: TAddress; fee: string } | { move: string; fee: string };

/** one of the pocket's transparent addresses, what it holds and in how many coins */
export type OwnT = TAddress & { zat: bigint; coins: number };

type Plan = (req: DepositRequest) => Promise<DepositPlan>;

const requestOf = (pay: TPayment, t: TAddress): DepositRequest => ({
  ...pay,
  tAddress: t.address,
  tIndex: t.index,
  memo: '',
});

/**
 * From the public balance: the first own address that covers the payment
 * alone, at its planned fee; undefined when none does. Only an address
 * holding more than the amount is planned.
 */
export const publicRoute = async (
  own: readonly OwnT[],
  plan: Plan,
  pay: TPayment,
): Promise<PayRoute | undefined> => {
  for (const { zat, coins: _, ...t } of own) {
    if (zat <= BigInt(pay.amountZat)) {
      continue;
    }
    const p = await plan(requestOf(pay, t));
    if (p.short === '0') {
      return { from: t, fee: p.fee };
    }
  }
  return undefined;
};

/** from the shielded pool: the amount and the fresh address's one-input fee are moved first */
export const moveRoute = (pay: TPayment): { move: string; fee: string } => {
  const fee = depositFeeZat(0);
  return { move: String(BigInt(pay.amountZat) + fee), fee: String(fee) };
};

/** the most one address can pay from the public balance: its coins less the fee of spending them all */
export const publicMax = (own: readonly OwnT[]): bigint =>
  own.reduce((most, t) => {
    const can = t.zat - depositFeeZat(0, t.coins);
    return can > most ? can : most;
  }, 0n);

/**
 * The pocket's addresses as the public balance reads them: what each holds
 * and in how many coins, by derivation index (array position), less any an
 * open swap or payment is funding.
 */
export const ownOf = (
  tAddresses: readonly string[],
  utxos: readonly { address: string; valueZat: bigint }[],
  busy: ReadonlySet<number>,
): OwnT[] =>
  tAddresses
    .map((address, index) => {
      const coins = utxos.filter(u => u.address === address);
      return {
        index,
        address,
        zat: coins.reduce((n, u) => n + u.valueZat, 0n),
        coins: coins.length,
      };
    })
    .filter(t => t.coins > 0 && !busy.has(t.index));
