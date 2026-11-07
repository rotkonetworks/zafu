/**
 * Paying a ZIP 320 tex address, which takes transparent inputs only. One of
 * this pocket's transparent addresses that already covers the payment pays it
 * at once. Otherwise the shielded pool funds a fresh, never-used transparent
 * address first, and once that move is mined the fresh address pays the tex.
 * The fresh address is the pocket's own (it is scanned like the rest), so a
 * run stopped between the two legs leaves the zec there, where the next tex
 * send pays from it directly.
 */

import {
  depositFeeZat,
  type DepositPlan,
  type DepositRequest,
} from '../../../workers/transparent-deposit';

export interface TAddress {
  index: number;
  address: string;
}

export interface TexPayment {
  to: string;
  amountZat: string;
  mainnet: boolean;
}

/**
 * How a tex is paid, as reviewed: from one of the pocket's addresses at its
 * planned fee, or by moving `move` zatoshi from the shielded pool to a fresh
 * address that then pays with one input at `fee`.
 */
export type TexRoute = { from: TAddress; fee: string } | { move: string; fee: string };

export interface TexDeps {
  /** this pocket's transparent addresses, each with its t-branch index and what it holds */
  own: () => Promise<(TAddress & { zat: bigint })[]>;
  plan: (req: DepositRequest) => Promise<DepositPlan>;
  /** a fresh index above any handed out, claimed for good */
  claim: () => Promise<TAddress>;
  /** shielded -> `to`, `zat`; resolves the txid */
  move: (to: string, zat: string) => Promise<string>;
  /** the height `txid` was mined at, if it was */
  mined: (txid: string) => Promise<number | undefined>;
  pay: (req: DepositRequest & { reviewedFee: string }) => Promise<{ txid: string; fee: string }>;
  sleep: (ms: number) => Promise<void>;
  /** a line for the progress list; also what keeps the send watch from reading the wait as stuck */
  step: (line: string) => void;
  /** false once the person stopped the send */
  live: () => boolean;
}

/** a move confirms in a block or two; asking the light client is all a poll costs */
export const TEX_POLL_MS = 15_000;

export const TEX_STOPPED =
  'stopped · the zec waits on your own transparent address, a new send to this tex pays from it';

const requestOf = (pay: TexPayment, t: TAddress): DepositRequest => ({
  ...pay,
  tAddress: t.address,
  tIndex: t.index,
  memo: '',
});

/**
 * The route for the review: the first own address that covers it, else a
 * move. Only an address holding more than the amount is planned, so the
 * planner sees the one or two that could pay, not every address.
 */
export const texRoute = async (
  deps: Pick<TexDeps, 'own' | 'plan'>,
  pay: TexPayment,
): Promise<TexRoute> => {
  for (const { zat, ...t } of await deps.own()) {
    if (zat <= BigInt(pay.amountZat)) {
      continue;
    }
    const plan = await deps.plan(requestOf(pay, t));
    if (plan.short === '0') {
      return { from: t, fee: plan.fee };
    }
  }
  const fee = depositFeeZat(0);
  return { move: String(BigInt(pay.amountZat) + fee), fee: String(fee) };
};

/** pay the tex the reviewed way; the worker refuses a fee that moved since the review */
export const payTex = async (
  deps: TexDeps,
  pay: TexPayment,
  route: TexRoute,
): Promise<{ txid: string; fee: string; moveTxid?: string }> => {
  if ('from' in route) {
    return deps.pay({ ...requestOf(pay, route.from), reviewedFee: route.fee });
  }
  const fresh = await deps.claim();
  deps.step('moving from the shielded pool to a fresh transparent address');
  const moveTxid = await deps.move(fresh.address, route.move);
  while ((await deps.mined(moveTxid)) === undefined) {
    if (!deps.live()) {
      throw new Error(TEX_STOPPED);
    }
    deps.step('waiting for the network to confirm the move');
    await deps.sleep(TEX_POLL_MS);
  }
  if (!deps.live()) {
    throw new Error(TEX_STOPPED);
  }
  // mined is not yet indexed everywhere: the address is asked again until its coin shows
  const req = requestOf(pay, fresh);
  while ((await deps.plan(req)).short !== '0') {
    if (!deps.live()) {
      throw new Error(TEX_STOPPED);
    }
    deps.step('waiting for the network to confirm the move');
    await deps.sleep(TEX_POLL_MS);
  }
  deps.step('paying the tex address');
  return { ...(await deps.pay({ ...req, reviewedFee: route.fee })), moveTxid };
};
