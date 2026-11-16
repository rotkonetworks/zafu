/**
 * Hyperliquid, the ramp only: read the two USDC balances, and move USDC with
 * the three actions the account's own key signs (usdSend, spotSend,
 * withdraw3). No orders. Plain functions with an injectable fetch.
 *
 * SAFETY: postHyperliquidAction submits a signed action that moves funds. It
 * is only ever reached from an explicit, reviewed send.
 */

import { signUserAction, type HyperliquidSignature, type UserAction } from './sign';

type FetchFn = typeof fetch;

export const HYPERLIQUID_API = 'https://api.hyperliquid.xyz';

/**
 * The bridge on Arbitrum that credits USDC sent to it, and the least it
 * credits (docs: for developers > api > bridge2). Less than this is lost.
 */
export const HYPERLIQUID_BRIDGE = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
export const HYPERLIQUID_MIN_DEPOSIT = 5_000_000n;
/** what Hyperliquid keeps from a withdrawal (docs: exchange endpoint, withdraw3) */
export const HYPERLIQUID_WITHDRAW_FEE = 1_000_000n;

/** spot USDC as spotSend names it: name:tokenId, from the api's spotMeta */
const SPOT_USDC = 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054';
/** Arbitrum, the chain the EIP-712 domain names; it only binds the signature */
const SIGNATURE_CHAIN = '0xa4b1';

const DECIMALS = 6;

/** "12.5" -> 12500000n; digits past the sixth are dropped, never rounded up */
export const usdcToMicro = (text: string): bigint => {
  const [whole = '', frac = ''] = text.split('.');
  return BigInt(whole + frac.slice(0, DECIMALS).padEnd(DECIMALS, '0'));
};

/** 12500000n -> "12.5", the form that is shown, signed and sent */
export const microToUsdc = (micro: bigint): string => {
  const digits = micro.toString().padStart(DECIMALS + 1, '0');
  const frac = digits.slice(-DECIMALS).replace(/0+$/, '');
  return digits.slice(0, -DECIMALS) + (frac ? `.${frac}` : '');
};

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

/** USDC an account can move right now, in millionths */
export interface HyperliquidBalances {
  /** perp account: what no open position is using */
  perp: bigint;
  /** spot account: total less what open orders reserve */
  spot: bigint;
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
  const usdc = spot.balances.find(b => b.coin === 'USDC');
  return {
    perp: usdcToMicro(perp.withdrawable),
    spot: usdc ? usdcToMicro(usdc.total) - usdcToMicro(usdc.hold) : 0n,
  };
}

/** the three ways USDC leaves: to a Hyperliquid address from either account, or to Arbitrum */
export type HyperliquidMove = 'usdSend' | 'spotSend' | 'withdraw3';

export const buildHyperliquidAction = (
  type: HyperliquidMove,
  destination: string,
  micro: bigint,
  time: number,
): UserAction => {
  if (!isHyperliquidAddress(destination)) {
    throw new Error('not a hyperliquid address');
  }
  if (micro <= 0n) {
    throw new Error('nothing to send');
  }
  const transfer = {
    hyperliquidChain: 'Mainnet',
    signatureChainId: SIGNATURE_CHAIN,
    destination: destination.toLowerCase(),
    amount: microToUsdc(micro),
    time,
  } as const;
  return type === 'spotSend' ? { ...transfer, type, token: SPOT_USDC } : { ...transfer, type };
};

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
