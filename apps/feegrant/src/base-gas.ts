import { readFileSync } from 'node:fs';
import type { LimitDenial } from './limits';

/**
 * Base gas drip for zafu's Peer buy.
 *
 * A buy signals a Peer intent from the person's own fresh Base address, which
 * holds no eth. This sends that address a few cents of eth once a day so it
 * can pay for its own transactions (signal, release, and the USDC hop to the
 * swap). Funds never pass through here: only gas.
 *
 *   POST /base/gas  { address, intent: { depositId, amount, platform, currency } }
 *     200 { txHash, wei }        drip sent
 *     409 { error: 'funded' }    the address already holds enough eth
 *     429 { error: 'rate', retryAfter }
 *     4xx/5xx                    no drip this time
 *
 * Permissionless like the Injective grant: an extension can't hold a secret.
 * Bounded by the drip size, one drip per address per day, per-IP limits and a
 * daily cap, so the worst case is a few dollars a day.
 */

export interface BaseGasConfig {
  /** the sponsor's private key; from BASE_KEY_FILE, never logged */
  privateKey: `0x${string}`;
  rpcUrl: string;
  /** eth sent per drip, in wei */
  dripWei: bigint;
  /** an address holding at least this much eth pays its own gas */
  fundedAboveWei: bigint;
  /** stop dripping when the sponsor holds less than this */
  minSponsorWei: bigint;
  dailyDripCap: number;
  perIpDailyDripCap: number;
  perIpRequestsPerHour: number;
  stateFile: string;
}

/** null when BASE_KEY_FILE is unset: the Base drip is simply not offered */
export const loadBaseGasConfig = (env = process.env): BaseGasConfig | null => {
  const keyFile = env['BASE_KEY_FILE'];
  if (!keyFile) {
    return null;
  }
  const privateKey = readFileSync(keyFile, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(`BASE_KEY_FILE (${keyFile}) does not hold a 0x private key`);
  }
  const big = (name: string, fallback: string): bigint => {
    const v = env[name] ?? fallback;
    if (!/^\d+$/.test(v)) {
      throw new Error(`env ${name} must be an integer amount in wei`);
    }
    return BigInt(v);
  };
  const int = (name: string, fallback: number): number => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`env ${name} must be a non-negative integer`);
    }
    return n;
  };
  return {
    privateKey: privateKey as `0x${string}`,
    rpcUrl: env['BASE_RPC'] ?? 'https://mainnet.base.org',
    dripWei: big('BASE_DRIP_WEI', '20000000000000'), // 0.00002 eth, ~$0.05
    fundedAboveWei: big('BASE_FUNDED_ABOVE_WEI', '10000000000000'), // 0.00001 eth
    minSponsorWei: big('BASE_MIN_SPONSOR_WEI', '200000000000000'), // 0.0002 eth
    dailyDripCap: int('BASE_DAILY_DRIP_CAP', 200),
    perIpDailyDripCap: int('BASE_PER_IP_DAILY_DRIP_CAP', 3),
    perIpRequestsPerHour: int('BASE_PER_IP_REQUESTS_PER_HOUR', 30),
    stateFile: env['BASE_STATE_FILE'] ?? './base-gas-state.json',
  };
};

export interface BaseGasDeps {
  config: Pick<BaseGasConfig, 'dripWei' | 'fundedAboveWei' | 'minSponsorWei'>;
  sponsorAddress: `0x${string}`;
  balanceOf: (address: `0x${string}`) => Promise<bigint>;
  send: (to: `0x${string}`, wei: bigint) => Promise<`0x${string}`>;
  admit: (ip: string) => LimitDenial | null;
  recordGrant: (ip: string) => void;
  /** when this address was last dripped (ms), in memory only */
  lastDrip: Map<string, number>;
  now: () => number;
  log: (msg: string) => void;
}

export interface BaseGasResult {
  status: number;
  body: Record<string, unknown>;
}

const DAY_MS = 86_400_000;
const PLATFORM = /^[a-z][a-z0-9_-]{1,31}$/;
const CURRENCY = /^[A-Za-z]{3}$/;

/** the buy the drip is for: shaped like a real Peer offer, or refused */
/** a string or number field as text; anything else reads as empty */
const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? String(v) : '';

const validIntent = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) {
    return false;
  }
  const i = v as Record<string, unknown>;
  const depositId = text(i['depositId']);
  const amount = text(i['amount']);
  return (
    /^\d{1,20}$/.test(depositId) &&
    /^\d{1,15}$/.test(amount) &&
    BigInt(amount) > 0n &&
    PLATFORM.test(text(i['platform'])) &&
    CURRENCY.test(text(i['currency']))
  );
};

/** POST /base/gas. Cheapest checks first; nothing is sent unless all pass. */
export const handleBaseGas = async (
  deps: BaseGasDeps,
  ip: string,
  body: unknown,
): Promise<BaseGasResult> => {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const address = text(b['address']).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { status: 400, body: { error: 'address must be a 0x Base address' } };
  }
  const key = address.toLowerCase();
  if (key === deps.sponsorAddress.toLowerCase()) {
    return { status: 400, body: { error: 'cannot sponsor the sponsor' } };
  }
  if (!validIntent(b['intent'])) {
    return { status: 400, body: { error: 'intent must describe the peer offer' } };
  }

  const last = deps.lastDrip.get(key);
  if (last !== undefined && deps.now() - last < DAY_MS) {
    return {
      status: 429,
      body: { error: 'rate', retryAfter: Math.ceil((last + DAY_MS - deps.now()) / 1000) },
    };
  }
  const denial = deps.admit(ip);
  if (denial) {
    return { status: 429, body: { error: 'rate', code: denial, retryAfter: 3600 } };
  }

  let held: bigint;
  let sponsor: bigint;
  try {
    [held, sponsor] = await Promise.all([
      deps.balanceOf(address as `0x${string}`),
      deps.balanceOf(deps.sponsorAddress),
    ]);
  } catch (e) {
    deps.log(`base balance query failed: ${e instanceof Error ? e.message : String(e)}`);
    return { status: 502, body: { error: 'could not reach Base; try again' } };
  }
  if (held >= deps.config.fundedAboveWei) {
    return { status: 409, body: { error: 'funded' } };
  }
  if (sponsor < deps.config.minSponsorWei + deps.config.dripWei) {
    deps.log(`ALERT base sponsor balance low: ${sponsor} wei at ${deps.sponsorAddress}`);
    return { status: 503, body: { error: 'gas sponsorship is temporarily unavailable' } };
  }

  // claim before sending, so two quick requests can't both pass
  deps.lastDrip.set(key, deps.now());
  try {
    const txHash = await deps.send(address as `0x${string}`, deps.config.dripWei);
    deps.recordGrant(ip);
    return { status: 200, body: { txHash, wei: deps.config.dripWei.toString() } };
  } catch (e) {
    deps.lastDrip.delete(key);
    deps.log(`base drip failed: ${e instanceof Error ? e.message : String(e)}`);
    return { status: 502, body: { error: 'could not send gas; try again later' } };
  }
};

/** one send at a time, so the sponsor's nonces never collide */
export const serialize = <A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): ((...args: A) => Promise<R>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const run = tail.then(() => fn(...args));
    tail = run.catch(() => undefined);
    return run;
  };
};
