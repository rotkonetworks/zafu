/**
 * One buy, from the seller's usdc held for the person to shielded zec, as a
 * plain record and pure steps. The page drives it; storage keeps it (sealed);
 * the popup's in-flight card only reads it. Every clock it shows is a real
 * one: the intent's on-chain time, the moments each step landed.
 */

import type { Offer } from './fees';
import type { TemplateKey } from './apps';

/**
 *  reserving -> pay -> confirming -> released -> swapping -> done
 *                 \-> expired                         \-> refunded
 */
export type Stage =
  | 'reserving'
  | 'pay'
  | 'confirming'
  | 'released'
  | 'swapping'
  | 'done'
  | 'refunded'
  | 'expired';

/** an offer as json: bigints as decimal strings */
export type SavedOffer = { [K in keyof Offer]: Offer[K] extends bigint ? string : Offer[K] };

export interface NearLeg {
  depositAddress: string;
  /** usdc sent, 6 decimals */
  amountIn: string;
  /** zec, 8 decimals */
  amountOut: string;
  minAmountOut: string;
  /** seconds 1click expects end to end */
  timeEstimate?: number;
  quotedAt: number;
  deadline?: string;
}

export interface OpenBuy {
  v: 1;
  stage: Stage;
  /** when each stage began (ms); the trackers' clocks */
  at: Partial<Record<Stage, number>>;
  app: string;
  /** the zelle bank, once chosen */
  template?: TemplateKey;
  currency: string;
  offer: SavedOffer;
  /** the person's base address: the intent's `to`, the 1click refund */
  base: `0x${string}`;
  /** where the zec lands: the wallet's shielded address */
  zcash: string;
  /** which wallet and pocket, for the arrival line */
  walletLabel?: string;
  reserveTx?: `0x${string}`;
  intentHash?: `0x${string}`;
  /** the intent's own expiry (on-chain time + Peer's 6 h) */
  expiresAt?: number;
  fulfillTx?: `0x${string}`;
  near?: NearLeg;
  depositTx?: `0x${string}`;
  /** zec that arrived, 8 decimals */
  arrived?: string;
}

/** Peer's escrow keeps an unpaid intent this long (EscrowV2 intentExpirationPeriod) */
export const INTENT_LIFETIME_MS = 6 * 60 * 60 * 1000;

export const saveOffer = (o: Offer): SavedOffer =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
  ) as SavedOffer;

export const loadOffer = (o: SavedOffer): Offer => ({
  ...o,
  rate: BigInt(o.rate),
  fiat: BigInt(o.fiat),
  gross: BigInt(o.gross),
  peerFee: BigInt(o.peerFee),
  zafuFee: BigInt(o.zafuFee),
  net: BigInt(o.net),
});

/** move to `stage`, stamping when it began */
export const advance = (
  b: OpenBuy,
  stage: Stage,
  patch: Partial<OpenBuy> = {},
  now = Date.now(),
): OpenBuy => ({
  ...b,
  ...patch,
  stage,
  at: { ...b.at, [stage]: b.at[stage] ?? now },
});

export const startBuy = (
  p: Pick<OpenBuy, 'app' | 'currency' | 'base' | 'zcash' | 'walletLabel'> & { offer: Offer },
  now = Date.now(),
): OpenBuy => ({
  v: 1,
  stage: 'reserving',
  at: { reserving: now },
  app: p.app,
  currency: p.currency,
  offer: saveOffer(p.offer),
  base: p.base,
  zcash: p.zcash,
  walletLabel: p.walletLabel,
});

export const isTerminal = (s: Stage): boolean =>
  s === 'done' || s === 'refunded' || s === 'expired';

/** what the chain and 1click say now; each is read only when the page is visible */
export interface Facts {
  now: number;
  /** the intent on Base: still held, gone (fulfilled or released), or unread */
  intent?: 'held' | 'gone';
  /** usdc on the person's base address, 6 decimals */
  usdc?: bigint;
  /** 1click's status for the deposit */
  swap?: 'pending' | 'success' | 'refunded' | 'failed';
  /** zec 1click delivered, 8 decimals */
  swapOut?: string;
}

/**
 * Where a saved buy stands, given fresh facts. Pure: the page calls it on
 * open and while visible, then writes what it returns.
 */
export const resume = (b: OpenBuy, f: Facts): OpenBuy => {
  switch (b.stage) {
    case 'reserving':
      // the reserve landed while the page was closed: the page reads the
      // receipt for the intent hash; without a tx nothing was ever sent
      return b;
    case 'pay':
    case 'confirming':
      if (f.intent === 'gone') {
        // released to the person (usdc is here), or returned to the seller
        return f.usdc !== undefined && f.usdc >= BigInt(b.offer.net)
          ? advance(b, 'released', {}, f.now)
          : advance(b, 'expired', {}, f.now);
      }
      if (b.expiresAt && f.now >= b.expiresAt) {
        return advance(b, 'expired', {}, f.now);
      }
      return b;
    case 'swapping':
      return f.swap === 'success'
        ? advance(b, 'done', { arrived: f.swapOut ?? b.near?.amountOut }, f.now)
        : f.swap === 'refunded' || f.swap === 'failed'
          ? advance(b, 'refunded', {}, f.now)
          : b;
    default:
      return b;
  }
};

/** the in-flight card's two lines, from the record alone (no network) */
export const cardLines = (
  b: OpenBuy,
  now = Date.now(),
): { title: string; status: string; tone: 'gold' | 'danger' } => {
  const zec = b.near ? `≈ ${(Number(b.near.amountOut) / 1e8).toFixed(4)} zec` : 'zec';
  const fiat = `${(Number(b.offer.fiat) / 1e6).toFixed(2)} ${b.currency}`;
  const left = b.expiresAt ? clock(b.expiresAt - now) : '';
  const title = `buying ${zec}`;
  switch (b.stage) {
    case 'reserving':
      return { title, status: 'holding the seller', tone: 'gold' };
    case 'pay':
      return {
        title,
        status: `pay ${b.offer.handle} ${fiat} on ${b.app}${left && ` · ${left} left`}`,
        tone: 'gold',
      };
    case 'confirming':
      return { title, status: "confirming your payment with peer's verifier", tone: 'gold' };
    case 'released':
      return { title, status: 'usdc arrived · swapping to zec', tone: 'gold' };
    case 'swapping':
      return { title, status: 'swapping to zec on near intents', tone: 'gold' };
    case 'refunded':
      return {
        title: 'the swap returned the usdc',
        status: 'it waits in your zafu base account',
        tone: 'danger',
      };
    case 'expired':
      return {
        title: 'the time to pay has passed',
        status: 'nothing was taken from you',
        tone: 'danger',
      };
    case 'done':
      return {
        title: `bought ${b.arrived ? (Number(b.arrived) / 1e8).toFixed(4) : ''} zec`,
        status: 'arrived shielded',
        tone: 'gold',
      };
  }
};

/** h:mm:ss, or m:ss under an hour; never negative */
export const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
