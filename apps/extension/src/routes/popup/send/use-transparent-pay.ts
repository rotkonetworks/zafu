/**
 * The send form's transparent payments, for a hot wallet paying a t1/t3 or
 * tex address. Shielded is the default source, as everywhere in zafu. The
 * person may pick their public balance instead: one address that covers the
 * payment alone pays it, never several together, and the form says plainly
 * that this links the payment to that address. A tex from the shielded pool
 * goes through a fresh address of its own (ZIP 320): it is an open payment
 * run by zcash/pay, so it carries on and resumes like a swap.
 *
 * The public balance is read only when the person picks it, from this
 * session's transparent check when there is one, else one address at a time.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useStore } from '../../../state';
import {
  planTransparentDepositInWorker,
  shieldInWorker,
} from '../../../state/keyring/network-worker';
import { selectZcashBackend, selectZcashEndpoint } from '../../../state/networks';
import { activeZcashStoreId } from '../../../state/pockets';
import { utxosEach, zcashClient } from '../../../state/keyring/zcash-backend';
import { isFinished, readOpenSwaps } from '../../../state/swap/open-swaps';
import { useSwapTAddress, useTransparentAddresses } from '../../../hooks/use-transparent-addresses';
import { useTransparentBalance } from '../../../hooks/zcash-transparent-balance';
import { legContextOf } from '../../../zcash/pay/legs';
import { openPayments, type OpenPayment } from '../../../zcash/pay/open-payments';
import { runPayment } from '../../../zcash/pay/run';
import { openPayUnlock } from '../../../zcash/pay/via-fresh';
import {
  moveRoute,
  ownOf,
  publicMax,
  publicRoute,
  type TAddress,
  type TPayment,
} from '../../../zcash/pay/route';
import type { VaultUnlock } from '../../../state/keyring/types';
import { quoteSend } from './spendable';

export type PaySource = 'shielded' | 'public';

/** what confirm started: a payment that went out, or an open payment now running */
export interface TransparentStart {
  running: OpenPayment;
  feeZat: bigint;
  /** the public address that pays, when it is the public balance */
  from?: TAddress;
}

export const PUBLIC_LINE = 'anyone can link this payment to that public address';
/** the tracker's words for a tex paid from the shielded pool */
export const FRESH_WORDS = {
  noun: 'payment',
  move: 'unshield to a fresh address of yours',
  pay: 'pay the tex address',
  sits: 'the zec waits on your fresh address,',
  notPaid: 'nothing was paid yet',
  held: 'the move is in · the payment waits for your signature',
  resume: 'sign the payment',
  shows: 'public · the amount, the tex address and your fresh address show',
};

/** the tracker's words for a payment from the public balance */
export const PUBLIC_WORDS = {
  ...FRESH_WORDS,
  pay: 'pay from your public balance',
  shows: 'public · your public address, where it went and the amount show',
};

export const FRESH_LINE = 'moves through a fresh public address of yours first · two transactions';

/** the indices an open swap or payment is funding: never spent from here */
const busyIndices = async (): Promise<Set<number>> => {
  const [swaps, pays] = await Promise.all([readOpenSwaps(), openPayments.read()]);
  return new Set([
    ...swaps.filter(s => !isFinished(s) && s.swapT).map(s => s.swapT!.index),
    ...pays.map(p => p.req.tIndex),
  ]);
};

export const useTransparentPay = ({
  hot,
  pool,
  to,
  amount,
  mainnet,
  review,
  notes,
  walletId,
  getVaultUnlock,
}: {
  hot: boolean;
  /** the recipient's pool, decoded */
  pool?: 'shielded' | 'transparent' | 'tex';
  to: string;
  amount: string;
  mainnet: boolean;
  /** the review is showing: the public route is planned then */
  review: boolean;
  /** unspent note values in the pool a move spends */
  notes: bigint[];
  walletId?: string;
  getVaultUnlock: (walletId: string) => Promise<VaultUnlock>;
}) => {
  const queryClient = useQueryClient();
  const storeId = useStore(activeZcashStoreId);
  const zidecarUrl = useStore(selectZcashEndpoint);
  const backend = useStore(selectZcashBackend);
  const { tAddresses } = useTransparentAddresses(mainnet);
  const session = useTransparentBalance(tAddresses).last?.utxos;
  const claim = useSwapTAddress(mainnet, queryClient).claim;
  const [source, setSource] = useState<PaySource>('shielded');

  const amountZat = /^\d*\.?\d+$/.test(amount.trim())
    ? BigInt(Math.round(Number(amount) * 1e8))
    : 0n;
  const payment: TPayment = { to, amountZat: String(amountZat), mainnet };
  /** the person may pick the public balance for a transparent recipient */
  const canPublic = hot && (pool === 'transparent' || pool === 'tex');
  const fromPublic = canPublic && source === 'public';
  /** a tex from the shielded pool, through a fresh address */
  const viaFresh = hot && pool === 'tex' && !fromPublic;

  const own = useQuery({
    queryKey: ['zcashOwnT', storeId, tAddresses.length, !!session],
    queryFn: async () =>
      ownOf(
        tAddresses,
        session ?? (await utxosEach(zcashClient(zidecarUrl, backend), tAddresses)),
        await busyIndices(),
      ),
    enabled: fromPublic && tAddresses.length > 0,
    staleTime: 60_000,
    retry: false,
    structuralSharing: false, // bigint
  });
  const most = own.data ? publicMax(own.data) : undefined;
  const route = useQuery({
    queryKey: ['zcashPublicRoute', storeId, to, payment.amountZat, own.dataUpdatedAt],
    queryFn: async () =>
      (await publicRoute(
        own.data!,
        req => planTransparentDepositInWorker(zidecarUrl, req),
        payment,
      )) ?? null,
    enabled: fromPublic && review && amountZat > 0n && !!own.data,
    staleTime: 30_000,
    retry: false,
  });
  const fresh = viaFresh ? moveRoute(payment) : undefined;
  const move =
    fresh && amountZat > 0n
      ? quoteSend(notes, BigInt(fresh.move), { transparentRecipient: true })
      : undefined;

  /** the public route as planned, once it is */
  const from = route.data && 'from' in route.data ? route.data : undefined;
  const feeZat = fromPublic
    ? from && BigInt(from.fee)
    : fresh && move?.ok
      ? BigInt(fresh.fee) + move.feeZat
      : undefined;

  return {
    canPublic,
    source,
    setSource,
    /** the form defers to this hook for the amount and the review */
    active: fromPublic || viaFresh,
    fromPublic,
    /** what the amount field offers: null while the public balance is read */
    available: fromPublic ? (most ?? null) : undefined,
    /** a fresh payment's max: the move's max less the fresh address's fee */
    freshMax: (shieldedMax: bigint) =>
      fresh ? (shieldedMax > BigInt(fresh.fee) ? shieldedMax - BigInt(fresh.fee) : 0n) : 0n,
    overLimit: fromPublic ? most !== undefined && amountZat > most : !!move && !move.ok,
    feeZat,
    ready: feeZat !== undefined,
    /** the review's line under the facts, and whether it warns */
    line: fromPublic
      ? own.isError || route.isError
        ? { warn: true, text: "the network didn't answer · please try again" }
        : route.data === null
          ? { warn: true, text: 'no single public address holds this · nothing was sent' }
          : { warn: true, text: `from your public balance · ${PUBLIC_LINE}` }
      : viaFresh
        ? move && !move.ok
          ? { warn: true, text: "your balance doesn't cover this and its fees · nothing was sent" }
          : { warn: false, text: FRESH_LINE }
        : undefined,
    privacy: fromPublic
      ? 'public · where it came from, where it went and the amount are visible to anyone'
      : undefined,

    /**
     * Confirm: an open payment, run by zcash/pay. From the public balance its
     * address is already funded, so the run pays at once; from the shielded
     * pool it moves to a fresh address first.
     */
    start: async (): Promise<TransparentStart> => {
      const ctx = legContextOf(useStore.getState());
      if (!storeId || !ctx || feeZat === undefined || (fromPublic ? !from : !fresh)) {
        throw new Error("zafu couldn't price this yet · nothing was sent, please try again");
      }
      const t = fromPublic ? from!.from : await claim();
      const p: OpenPayment = {
        v: 1,
        id: `${Date.now().toString(36)}-${t.index}`,
        wallet: storeId,
        at: Date.now(),
        req: {
          ...payment,
          memo: '',
          tAddress: t.address,
          tIndex: t.index,
          reviewedFee: fromPublic ? from!.fee : fresh!.fee,
        },
      };
      // remembered (sealed) before anything moves, so a closed popup loses nothing
      await openPayments.save(p);
      await openPayUnlock(p.id, undefined, ctx.legsPerUnlock);
      // a fresh address is empty: the reviewed plan is the whole move
      runPayment(p, ctx, fresh && { fee: fresh.fee, change: '0', short: fresh.move });
      void queryClient.invalidateQueries({ queryKey: ['zcashOwnT'] });
      return { running: p, feeZat, from: fromPublic ? t : undefined };
    },

    /** after a public payment: shield what is left on that one address, alone */
    shieldRest: async (address: string) => {
      if (!storeId || !walletId) {
        throw new Error('no wallet selected');
      }
      return shieldInWorker(
        'zcash',
        storeId,
        await getVaultUnlock(walletId),
        zidecarUrl,
        tAddresses,
        mainnet,
        undefined,
        [address],
      );
    },
  };
};
