import { INJECTIVE_STABLE_DENOMS } from '@repo/wallet/networks/injective/feegrant';
import { readFileSync } from 'node:fs';

/**
 * Service configuration, read once from the environment at startup.
 *
 * Amounts are in base units: INJ has 18 decimals, USDC.inj has 6.
 */
export interface Config {
  /** Granter mnemonic. Loaded from FEEGRANT_MNEMONIC_FILE; never logged. */
  mnemonic: string;
  accountIndex: number;
  lcdUrl: string;
  chainId: string;
  host: string;
  port: number;
  /** Take the client IP from X-Forwarded-For (only behind our own proxy). */
  trustProxy: boolean;

  /** Per-grant fee allowance, e.g. 0.001 INJ covers ~5 shields at 0.0002 INJ. */
  spendLimit: bigint;
  grantTtlMs: number;
  /** The largest single shield fee a client will spend; a grant below this is "exhausted". */
  shieldFee: bigint;

  usdcDenom: string;
  /**
   * Only sponsor addresses holding at least `minUsdc` (base units, all 6-dec)
   * of one of these Penumbra-accepted stablecoins. Stablecoins only: an
   * unpriced token would let anyone qualify with dust across many addresses.
   */
  stableDenoms: string[];
  minUsdc: bigint;
  /** Only sponsor addresses holding less INJ than this (others can pay their own gas). */
  sponsorBelowInj: bigint;

  dailyGrantCap: number;
  perIpDailyGrantCap: number;
  perIpRequestsPerHour: number;
  /** Refuse new grants when the granter's own balance drops below this. */
  minGranterBalance: bigint;

  stateFile: string;
}

const str = (name: string, fallback?: string): string => {
  const v = process.env[name];
  if (v !== undefined && v !== '') {
    return v;
  }
  if (fallback === undefined) {
    throw new Error(`missing required env ${name}`);
  }
  return fallback;
};

const int = (name: string, fallback: number): number => {
  const n = Number(str(name, String(fallback)));
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`env ${name} must be a non-negative integer`);
  }
  return n;
};

const big = (name: string, fallback: string): bigint => {
  const v = str(name, fallback);
  if (!/^\d+$/.test(v)) {
    throw new Error(`env ${name} must be an integer amount in base units`);
  }
  return BigInt(v);
};

export const loadConfig = (): Config => {
  const mnemonicFile = str('FEEGRANT_MNEMONIC_FILE');
  const mnemonic = readFileSync(mnemonicFile, 'utf8').trim();
  if (mnemonic.split(/\s+/).length < 12) {
    throw new Error(`FEEGRANT_MNEMONIC_FILE (${mnemonicFile}) does not contain a mnemonic`);
  }

  return {
    mnemonic,
    accountIndex: int('FEEGRANT_ACCOUNT_INDEX', 0),
    lcdUrl: str('INJECTIVE_LCD', 'https://sentry.lcd.injective.network'),
    chainId: str('INJECTIVE_CHAIN_ID', 'injective-1'),
    host: str('HOST', '127.0.0.1'),
    port: int('PORT', 3335),
    trustProxy: str('TRUST_PROXY', '0') === '1',

    spendLimit: big('SPEND_LIMIT', '1000000000000000'), // 0.001 INJ
    grantTtlMs: int('GRANT_TTL_HOURS', 24) * 3_600_000,
    shieldFee: big('SHIELD_FEE', '200000000000000'), // 0.0002 INJ (400k gas @ 5e8)

    usdcDenom: str('USDC_DENOM', 'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a'),
    stableDenoms: str('STABLE_DENOMS', INJECTIVE_STABLE_DENOMS.join(','))
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(Boolean),
    minUsdc: big('MIN_USDC', '1000000'), // 1 unit of a stablecoin
    sponsorBelowInj: big('SPONSOR_BELOW_INJ', '1000000000000000'), // 0.001 INJ

    dailyGrantCap: int('DAILY_GRANT_CAP', 200),
    perIpDailyGrantCap: int('PER_IP_DAILY_GRANT_CAP', 3),
    perIpRequestsPerHour: int('PER_IP_REQUESTS_PER_HOUR', 30),
    minGranterBalance: big('MIN_GRANTER_BALANCE', '100000000000000000'), // 0.1 INJ

    stateFile: str('STATE_FILE', './feegrant-state.json'),
  };
};
