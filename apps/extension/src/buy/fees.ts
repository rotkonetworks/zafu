/**
 * Buy money math, pure. Peer's curator prices a quote with every fee already
 * applied (its own 0.95% service fee and any referral fee zafu asks for), so
 * the ticket only reads its numbers back as lines; nothing here invents one.
 *
 * Units: usdc in 6-decimal base units (bigint), fiat as Peer sends it
 * (6-decimal base units, string), rates as 18-decimal fixed point.
 */

import { ZAFU_BUY_FEE_BPS, ZAFU_BUY_FEE_BPS_LIST, ZAFU_BUY_FEE_RECIPIENT } from '../config/ramps';

/** one seller's offer, as the buy page needs it */
export interface Offer {
  depositId: string;
  /** the seller's handle on the app (public in Peer's quote api) */
  handle: string;
  payeeDetails: string;
  escrow: `0x${string}`;
  fiatCurrencyHash: string;
  platform: string;
  /** fiat per usdc, 18 decimals */
  rate: bigint;
  /** fiat the buyer pays, 6 decimals */
  fiat: bigint;
  /** usdc the seller releases (signalIntent amount) */
  gross: bigint;
  peerFee: bigint;
  peerBps: number;
  zafuFee: bigint;
  /** usdc that lands on the buyer's base address */
  net: bigint;
}

/** a quote row from api.zkp2p.xyz /v3/quote/exact-fiat */
export interface PeerQuoteRow {
  fiatAmount: string;
  tokenAmount: string;
  signalIntentAmount?: string;
  zkp2pFeeAmount?: string;
  serviceFeeBps?: number;
  takerReferralFeeAmount?: string;
  conversionRate: string;
  intent: {
    depositId: number | string;
    processorName: string;
    payeeDetails: string;
    fiatCurrencyCode: string;
    escrowAddress: string;
  };
  maker?: { offchainId?: string };
  payeeData?: { offchainId?: string };
}

const big = (s: string | undefined): bigint => (s && /^\d+$/.test(s) ? BigInt(s) : 0n);

export const toOffer = (q: PeerQuoteRow): Offer => {
  const gross = big(q.signalIntentAmount) || big(q.tokenAmount);
  return {
    depositId: String(q.intent.depositId),
    handle: q.maker?.offchainId ?? q.payeeData?.offchainId ?? '',
    payeeDetails: q.intent.payeeDetails,
    escrow: q.intent.escrowAddress as `0x${string}`,
    fiatCurrencyHash: q.intent.fiatCurrencyCode,
    platform: q.intent.processorName,
    rate: big(q.conversionRate),
    fiat: big(q.fiatAmount),
    gross,
    peerFee: big(q.zkp2pFeeAmount),
    peerBps: q.serviceFeeBps ?? 0,
    zafuFee: big(q.takerReferralFeeAmount),
    net: big(q.tokenAmount),
  };
};

/** best first: the most usdc on the buyer's address for the same fiat */
export const byBest = (a: Offer, b: Offer): number => (b.net > a.net ? 1 : b.net < a.net ? -1 : 0);

/** what zafu asks Peer to add to the quote and the intent; nothing without a recipient */
export const zafuReferral = (
  recipient: `0x${string}` | null = ZAFU_BUY_FEE_RECIPIENT,
  bps = ZAFU_BUY_FEE_BPS,
): { recipient: `0x${string}`; feeBps: number } | undefined =>
  recipient && bps > 0 ? { recipient, feeBps: bps } : undefined;

/** the referral fee Peer's contract pays out, on the released amount */
export const zafuFeeOf = (gross: bigint, bps = ZAFU_BUY_FEE_BPS): bigint =>
  (gross * BigInt(bps)) / 10_000n;

/** "60" for 0.5% -> 0.2%: the discount the struck rate shows, from the constants */
export const offPct = (list = ZAFU_BUY_FEE_BPS_LIST, bps = ZAFU_BUY_FEE_BPS): number =>
  Math.round(100 - (bps * 100) / list);

export const pct = (bps: number): string => `${+(bps / 100).toFixed(2)}%`;

/** 6-decimal units -> "98.04" */
export const usdc2 = (units: bigint): string => (Number(units) / 1e6).toFixed(2);

/** 18-decimal rate -> "1.020" */
export const rate3 = (rate: bigint): string => (Number(rate / 10n ** 12n) / 1e6).toFixed(3);

/** a typed amount -> Peer's 6-decimal fiat units, or undefined when not a positive number */
export const fiatUnits = (text: string): bigint | undefined => {
  const m = /^\s*(\d{0,9})(?:\.(\d{0,6}))?\s*$/.exec(text.replace(/,/g, ''));
  if (!m || (!m[1] && !m[2])) {
    return undefined;
  }
  const units = BigInt(m[1] || '0') * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  return units > 0n ? units : undefined;
};

export interface TicketRow {
  k: string;
  v: string;
  /** the true list value shown struck through before `v` */
  struck?: string;
  /** a quiet tail after `v` ("60% off in beta") */
  note?: string;
  tone?: 'green' | 'warn';
}

/**
 * Every fee as its own line. `swapCost` is NEAR's cost in usdc once a quote
 * is in (undefined before); `gas` is how the base network fee is paid.
 */
export const ticketRows = (
  o: Offer,
  currency: string,
  swapCost: bigint | undefined,
  gas: 'sponsored' | 'needs-eth' | 'unknown',
): TicketRow[] => [
  { k: 'seller rate', v: `${rate3(o.rate)} ${currency} per usdc` },
  { k: 'usdc from the seller', v: usdc2(o.gross) },
  { k: `peer · ${pct(o.peerBps)}`, v: `−${usdc2(o.peerFee)}` },
  ...(o.zafuFee > 0n
    ? [
        {
          k: 'zafu',
          struck: pct(ZAFU_BUY_FEE_BPS_LIST),
          v: `${pct(ZAFU_BUY_FEE_BPS)} · −${usdc2(o.zafuFee)}`,
          note: `${offPct()}% off in beta`,
        },
      ]
    : []),
  { k: 'swap · near intents', v: swapCost === undefined ? 'at the swap' : `−${usdc2(swapCost)}` },
  gas === 'sponsored'
    ? { k: 'base gas', v: 'covered by zafu', tone: 'green' as const }
    : gas === 'needs-eth'
      ? { k: 'base gas', v: 'a little eth, from you', tone: 'warn' as const }
      : { k: 'base gas', v: 'cents' },
];
