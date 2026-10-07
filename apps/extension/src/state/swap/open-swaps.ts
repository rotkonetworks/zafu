/**
 * Cross-chain swaps in flight, between visits: what was quoted (deposit
 * address, memo, amounts, the price's expiry), the deposit's txid once sent,
 * and the swap's own transparent address (THORChain). An into-zec swap is
 * paid from another wallet, and switching to it closes the popup; this record
 * is how the swap screen picks it up again and how home shows it.
 *
 * Sealed at rest (ENCRYPTED_KEYS 'openSwaps'), like the open buy: addresses
 * and memos are never in the clear. A locked wallet reads as none and writes
 * nothing. Amounts are decimal strings (bigints don't survive json). It is
 * not a setting, so it is not in the personal backup.
 */

import { localExtStorage, type LocalStorageState } from '@repo/storage-chrome/local';
import { sessionExtStorage } from '@repo/storage-chrome/session';
import { readEncrypted, readEncryptedWithMigration, writeEncrypted } from '../encrypted-storage';
import type { Quote, SwapPhase, SwapToken } from './provider';
import type { RouteId, SwapPair } from './routes';
import type { Held } from '../../signing/move-and-deposit';

export const OPEN_SWAPS_KEY = 'openSwaps';
const KEY = OPEN_SWAPS_KEY as keyof LocalStorageState;

/**
 *  deposit -> sent -> done | refunded | failed
 *  thor-out (out of zec over thorchain: move, then deposit) -> sent
 */
export type OpenSwapStage = 'deposit' | 'thor-out' | 'sent' | 'done' | 'refunded' | 'failed';

export interface OpenSwap {
  v: 1;
  id: string;
  /** the pocket store the swap belongs to (swapWallet) */
  wallet: string;
  route: RouteId;
  direction: SwapPair['direction'];
  token: SwapToken;
  /** what is sent, decimal, in the asset sent */
  amountIn: string;
  amountInText: string;
  /** destination base units, as a decimal string */
  amountOut: string;
  amountOutText: string;
  atLeastText?: string;
  depositAddress: string;
  memo?: string;
  recipient: string;
  /** into zec: the refund address; from zec: where the token goes */
  otherAddress: string;
  /** ms epoch: the price's, or the window to pay in */
  expiresAt?: number;
  watch?: Quote['watch'];
  depositTxid?: string;
  /** thorchain out: the move that funds the swap's address, once sent */
  moveTxid?: string;
  /** thorchain out, zigner: the deposit signed with the move, sent once the move is mined */
  held?: Held;
  /** thorchain out: the deposit's network fee as reviewed; the deposit is refused at any other */
  depositFee?: string;
  /** the swap's own transparent address (THORChain) */
  swapT?: { index: number; address: string };
  stage: OpenSwapStage;
  /** the last status line the route gave */
  line?: string;
  /** when the swap was confirmed */
  at: number;
}

const TERMINAL = new Set<OpenSwapStage>(['done', 'refunded', 'failed']);
export const isFinished = (s: OpenSwap): boolean => TERMINAL.has(s.stage);

/** where a watched phase leaves the record; waiting and processing keep it 'sent' */
export const STAGE_FOR: Partial<Record<SwapPhase, OpenSwapStage>> = {
  done: 'done',
  refunded: 'refunded',
  failed: 'failed',
};

/** a stored value is an open swap only if it has the shape this build writes */
export const isOpenSwap = (v: unknown): v is OpenSwap => {
  const s = v as OpenSwap;
  return (
    !!s &&
    typeof s === 'object' &&
    s.v === 1 &&
    typeof s.id === 'string' &&
    typeof s.wallet === 'string' &&
    typeof s.stage === 'string' &&
    typeof s.depositAddress === 'string' &&
    typeof s.amountIn === 'string' &&
    !!s.token &&
    typeof s.token.symbol === 'string'
  );
};

/**
 * Nothing left to track: a deposit window that closed unpaid. 1click's gets a
 * day for a late deposit to show (it refunds one); thorchain into zec is never
 * watched, so it goes once its price ran out. A paid swap, or a thorchain swap
 * out (whose zec may already sit on its address), stays until the person
 * has seen how it ended.
 */
export const isStale = (s: OpenSwap, now = Date.now()): boolean =>
  s.stage === 'deposit' &&
  !s.depositTxid &&
  !!s.expiresAt &&
  now > s.expiresAt + (s.watch === 'deposit' ? 24 * 3600_000 : 0);

/** the open swaps; [] when locked or none, never a crash on the home screen */
export const readOpenSwaps = async (): Promise<OpenSwap[]> => {
  if (!(await sessionExtStorage.get('passwordKey'))) {
    return [];
  }
  const v = await readEncrypted<unknown>(localExtStorage, sessionExtStorage, KEY).catch(() => null);
  return Array.isArray(v) ? v.filter(isOpenSwap) : [];
};

/**
 * One change to the list, read-modify-write under a lock every realm shares.
 * False when locked (nothing written). A box that won't open is kept aside
 * (`openSwaps.unopened`), never overwritten in place.
 */
const change = async (fn: (list: OpenSwap[]) => OpenSwap[]): Promise<boolean> =>
  navigator.locks.request(`${chrome.runtime.id}.open-swaps`, { mode: 'exclusive' }, async () => {
    if (!(await sessionExtStorage.get('passwordKey'))) {
      return false;
    }
    const v = await readEncryptedWithMigration<unknown>(localExtStorage, sessionExtStorage, KEY);
    const list = Array.isArray(v) ? v.filter(isOpenSwap) : [];
    const next = fn(list).filter(s => !isStale(s));
    if (!next.length) {
      await chrome.storage.local.remove(OPEN_SWAPS_KEY);
      return true;
    }
    return writeEncrypted(localExtStorage, sessionExtStorage, KEY, next);
  });

/** remember a swap, or replace the one with its id */
export const saveOpenSwap = (s: OpenSwap): Promise<boolean> =>
  change(list => [...list.filter(x => x.id !== s.id), s]);

/** update one swap in place; nothing when it is gone */
export const patchOpenSwap = (id: string, patch: Partial<OpenSwap>): Promise<boolean> =>
  change(list => list.map(s => (s.id === id ? { ...s, ...patch } : s)));

export const forgetOpenSwap = (id: string): Promise<boolean> =>
  change(list => list.filter(s => s.id !== id));

/** call `fn` whenever the open swaps change in any realm */
export const onOpenSwapsChange = (fn: () => void): (() => void) => {
  const l = (changes: Record<string, chrome.storage.StorageChange>) => {
    if (OPEN_SWAPS_KEY in changes) {
      fn();
    }
  };
  chrome.storage.local.onChanged.addListener(l);
  return () => chrome.storage.local.onChanged.removeListener(l);
};

/** a quote as the record keeps it: strings for the bigints, no raw node answer */
export const openSwapOf = (
  q: Quote,
  r: { direction: SwapPair['direction']; token: SwapToken; amountIn: string; otherAddress: string },
  wallet: string,
  stage: OpenSwapStage,
  swapT?: { index: number; address: string },
  now = Date.now(),
): OpenSwap => ({
  v: 1,
  id: `${now.toString(36)}-${q.depositAddress.slice(-8)}`,
  wallet,
  route: q.route,
  direction: r.direction,
  token: { symbol: r.token.symbol, chain: r.token.chain, decimals: r.token.decimals },
  amountIn: r.amountIn,
  amountInText: q.amountInText,
  amountOut: q.amountOut.toString(),
  amountOutText: q.amountOutText,
  atLeastText: q.atLeastText,
  depositAddress: q.depositAddress,
  memo: q.memo,
  recipient: q.recipient,
  otherAddress: r.otherAddress,
  expiresAt: q.expiresAt,
  watch: q.watch,
  swapT,
  stage,
  at: now,
});

/** the record back as the quote the screen and the route's status read */
export const quoteOf = (s: OpenSwap): Quote => ({
  route: s.route,
  amountOut: BigInt(s.amountOut),
  amountOutText: s.amountOutText,
  amountInText: s.amountInText,
  atLeastText: s.atLeastText,
  expiresAt: s.expiresAt,
  depositAddress: s.depositAddress,
  memo: s.memo,
  recipient: s.recipient,
  watch: s.watch,
  raw: undefined,
});

/** h:mm:ss, or m:ss under an hour; never negative */
const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** home's in-flight card, from the record alone (no network) */
export const swapCardLines = (
  s: OpenSwap,
  now = Date.now(),
): { title: string; status: string; tone: 'gold' | 'info' | 'danger' } => {
  const sym = s.token.symbol.toLowerCase();
  const title =
    s.direction === 'into_zec' ? `swapping ${sym} into zec` : `swapping zec into ${sym}`;
  switch (s.stage) {
    case 'deposit':
      return s.direction === 'from_zec'
        ? { title, status: 'sending the deposit', tone: 'gold' }
        : s.expiresAt && s.expiresAt <= now
          ? {
              title,
              status: 'the deposit window closed · please check before paying',
              tone: 'info',
            }
          : {
              title,
              status: `pay ${s.amountInText} ${sym}${s.expiresAt ? ` · ${clock(s.expiresAt - now)} left` : ''}`,
              tone: 'gold',
            };
    case 'thor-out':
      return {
        title,
        status: s.moveTxid
          ? 'the network is confirming the move, then the swap'
          : "moving zec to the swap's address",
        tone: 'gold',
      };
    case 'sent':
      return { title, status: s.line ?? 'waiting for the deposit', tone: 'gold' };
    case 'done':
      return {
        title: `swapped ${s.amountInText} ${s.direction === 'into_zec' ? sym : 'zec'}`,
        status: 'swap complete',
        tone: 'gold',
      };
    case 'refunded':
      return { title, status: s.line ?? 'sent back · it is safe', tone: 'info' };
    case 'failed':
      return { title, status: s.line ?? 'the swap did not go through', tone: 'danger' };
  }
};
