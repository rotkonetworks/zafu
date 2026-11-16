/**
 * Hyperliquid, the ramp only: read the two USDC balances, and move USDC with
 * the three actions the account's own key signs (usdSend, spotSend,
 * withdraw3). No orders. Plain functions with an injectable fetch.
 *
 * SAFETY: postHyperliquidAction submits a signed action that moves funds. It
 * is only ever reached from an explicit, reviewed send.
 */

import { HYPERLIQUID_API } from './api';
import { signUserAction, type HyperliquidSignature, type UserAction } from './sign';

type FetchFn = typeof fetch;

/** spot USDC as spotSend names it: name:tokenId, from the api's spotMeta */
const SPOT_USDC = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';
/** Arbitrum, the chain the EIP-712 domain names; it only binds the signature */
const SIGNATURE_CHAIN = '0xa4b1';

/** UZEC, Unit's zec on the spot account, as spotSend names it */
const SPOT_UZEC = 'UZEC:0x1c994ad3381d31c86c8c2d74ed89a365';

/** "12.5" -> 12500000n at six decimals; digits past the last are dropped, never rounded up */
const toUnits = (text: string, decimals: number): bigint => {
  const [whole = '', frac = ''] = text.split('.');
  return BigInt(whole + frac.slice(0, decimals).padEnd(decimals, '0'));
};

/** 12500000n -> "12.5", the form that is shown, signed and sent */
const fromUnits = (units: bigint, decimals: number): string => {
  const digits = units.toString().padStart(decimals + 1, '0');
  const frac = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (frac ? `.${frac}` : '');
};

export const usdcToMicro = (text: string): bigint => toUnits(text, 6);
export const microToUsdc = (micro: bigint): string => fromUnits(micro, 6);
export const zecToZat = (text: string): bigint => toUnits(text, 8);
export const zatToZec = (zat: bigint): string => fromUnits(zat, 8);

export const isHyperliquidAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

const info = async (fetchFn: FetchFn, body: object): Promise<unknown> => {
  const res = await fetchFn(`${HYPERLIQUID_API}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`hyperliquid info failed: ${res.status}`);
  }
  return res.json();
};

/** what an account can move right now */
export interface HyperliquidBalances {
  /** perp account usdc, in millionths: what no open position is using */
  perp: bigint;
  /** spot account usdc, in millionths: total less what open orders reserve */
  spot: bigint;
  /** spot account uzec (Unit's zec), in zatoshi */
  uzec: bigint;
}

export async function queryHyperliquidBalances(
  address: string,
  fetchFn: FetchFn = fetch,
): Promise<HyperliquidBalances> {
  const user = address.toLowerCase();
  const [perp, spot] = (await Promise.all([
    info(fetchFn, { type: 'clearinghouseState', user }),
    info(fetchFn, { type: 'spotClearinghouseState', user }),
  ])) as [
    { withdrawable?: string },
    { balances?: { coin: string; total: string; hold: string }[] },
  ];
  if (typeof perp.withdrawable !== 'string' || !Array.isArray(spot.balances)) {
    throw new Error('hyperliquid sent balances zafu could not read');
  }
  const free = (coin: string, decimals: number) => {
    const b = spot.balances!.find(x => x.coin === coin);
    return b ? toUnits(b.total, decimals) - toUnits(b.hold, decimals) : 0n;
  };
  return { perp: usdcToMicro(perp.withdrawable), spot: free('USDC', 6), uzec: free('UZEC', 8) };
}

/** the three ways USDC leaves: to a Hyperliquid address from either account, or to Arbitrum */
export type HyperliquidMove = 'usdSend' | 'spotSend' | 'withdraw3';

const transfer = (destination: string, amount: string, time: number) => {
  if (!isHyperliquidAddress(destination)) {
    throw new Error('not a hyperliquid address');
  }
  if (!/[1-9]/.test(amount)) {
    throw new Error('nothing to send');
  }
  return {
    hyperliquidChain: 'Mainnet',
    signatureChainId: SIGNATURE_CHAIN,
    destination: destination.toLowerCase(),
    amount,
    time,
  } as const;
};

export const buildHyperliquidAction = (
  type: HyperliquidMove,
  destination: string,
  micro: bigint,
  time: number,
): UserAction => {
  const t = transfer(destination, microToUsdc(micro), time);
  return type === 'spotSend' ? { ...t, type, token: SPOT_USDC } : { ...t, type };
};

/** uzec from the spot account to another Hyperliquid address (Unit's, for a withdrawal) */
export const buildUzecSend = (destination: string, zat: bigint, time: number): UserAction => ({
  ...transfer(destination, zatToZec(zat), time),
  type: 'spotSend',
  token: SPOT_UZEC,
});

/** a signed action as the exchange endpoint takes it; `time` is its nonce */
export interface SignedHyperliquidAction {
  action: UserAction;
  nonce: number;
  signature: HyperliquidSignature;
}

export const signHyperliquidAction = (
  privateKey: Uint8Array,
  action: UserAction,
): SignedHyperliquidAction => ({
  action,
  nonce: action.time,
  signature: signUserAction(privateKey, action),
});

/**
 * What became of a posted action. `unclear` means no answer that says either
 * way: the action may or may not have gone through. Hyperliquid takes a nonce
 * once, so posting the SAME signed action again can never pay twice; signing
 * a new one could.
 */
export type HyperliquidOutcome =
  | { outcome: 'ok' }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'unclear'; reason: string };

export async function postHyperliquidAction(
  signed: SignedHyperliquidAction,
  fetchFn: FetchFn = fetch,
): Promise<HyperliquidOutcome> {
  let res: Response;
  try {
    res = await fetchFn(`${HYPERLIQUID_API}/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed),
    });
  } catch (e) {
    return { outcome: 'unclear', reason: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text().catch(() => '');
  // a 4xx is the exchange turning the request away before acting on it
  if (res.status >= 400 && res.status < 500) {
    return { outcome: 'refused', reason: text || `status ${res.status}` };
  }
  let body: { status?: unknown; response?: unknown } | undefined;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = undefined;
  }
  if (res.ok && body?.status === 'ok') {
    return { outcome: 'ok' };
  }
  if (res.ok && body?.status === 'err') {
    return {
      outcome: 'refused',
      reason: typeof body.response === 'string' ? body.response : 'no reason given',
    };
  }
  return { outcome: 'unclear', reason: `status ${res.status}` };
}
