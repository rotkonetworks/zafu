import { isValidInjectiveAddress } from '@repo/wallet/networks/injective/derive';
import type { InjectiveBalances } from '@repo/wallet/networks/injective/client';
import {
  MSG_SEND_TYPE_URL,
  MSG_TRANSFER_TYPE_URL,
  holdsSponsorStable,
} from '@repo/wallet/networks/injective/feegrant';
import type { Config } from './config';
import { GrantError, type GrantOutcome } from './granter';
import type { LimitDenial } from './limits';

export interface HandlerDeps {
  config: Pick<
    Config,
    'minUsdc' | 'sponsorBelowInj' | 'minGranterBalance' | 'usdcDenom' | 'stableDenoms'
  >;
  granterAddress: string;
  ensureGrant: (grantee: string, messageType: string) => Promise<GrantOutcome>;
  admit: (ip: string) => LimitDenial | null;
  recordGrant: (ip: string) => void;
  balances: (address: string) => Promise<InjectiveBalances>;
  log: (msg: string) => void;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

const DENIAL_MESSAGES: Record<LimitDenial, string> = {
  daily_budget: 'gas sponsorship budget for today is used up; pay gas in INJ or try tomorrow',
  ip_daily: 'too many sponsored addresses from this network today',
  ip_rate: 'too many requests; slow down',
};

/**
 * POST /v1/injective/grant. Checks run cheapest-first; nothing is signed unless
 * the address is valid, within limits, genuinely needs sponsoring (holds
 * USDC.inj but not enough INJ), and the sponsor itself is funded.
 */
export const handleGrant = async (
  deps: HandlerDeps,
  ip: string,
  body: unknown,
): Promise<HandlerResult> => {
  const address =
    typeof body === 'object' && body !== null && 'address' in body
      ? String((body as { address: unknown }).address).trim()
      : '';
  const purpose =
    typeof body === 'object' && body !== null && 'purpose' in body
      ? String((body as { purpose: unknown }).purpose)
      : 'shield';
  const messageType = purpose === 'send' ? MSG_SEND_TYPE_URL : MSG_TRANSFER_TYPE_URL;
  if (!isValidInjectiveAddress(address)) {
    return { status: 400, body: { error: 'address must be a valid inj1... address' } };
  }
  if (address === deps.granterAddress) {
    return { status: 400, body: { error: 'cannot sponsor the sponsor' } };
  }

  const denial = deps.admit(ip);
  if (denial) {
    return { status: 429, body: { error: DENIAL_MESSAGES[denial], code: denial } };
  }

  let grantee: InjectiveBalances;
  let sponsor: InjectiveBalances;
  try {
    [grantee, sponsor] = await Promise.all([
      deps.balances(address),
      deps.balances(deps.granterAddress),
    ]);
  } catch (e) {
    deps.log(`balance query failed: ${e instanceof Error ? e.message : String(e)}`);
    return { status: 502, body: { error: 'could not reach Injective; try again' } };
  }

  const holdsStable =
    grantee.usdc >= deps.config.minUsdc ||
    holdsSponsorStable(grantee.all ?? [], deps.config.stableDenoms, deps.config.minUsdc);
  if (!holdsStable) {
    return {
      status: 409,
      body: {
        error:
          'gas is sponsored for addresses holding a stablecoin (e.g. USDC.inj); deposit one first',
        code: 'no_usdc',
      },
    };
  }
  if (grantee.inj >= deps.config.sponsorBelowInj) {
    return {
      status: 409,
      body: { error: 'this address holds enough INJ to pay its own gas', code: 'has_inj' },
    };
  }
  if (sponsor.inj < deps.config.minGranterBalance) {
    deps.log(`ALERT sponsor balance low: ${sponsor.inj} base units INJ at ${deps.granterAddress}`);
    return { status: 503, body: { error: 'gas sponsorship is temporarily unavailable' } };
  }

  try {
    const outcome = await deps.ensureGrant(address, messageType);
    if (outcome.status === 'granted') {
      deps.recordGrant(ip);
    }
    return { status: 200, body: { granter: deps.granterAddress, ...outcome } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.log(`grant failed for ${address}: ${msg}`);
    if (e instanceof GrantError && e.retryable) {
      return { status: 503, body: { error: msg, retryable: true } };
    }
    return { status: 502, body: { error: 'could not issue the grant; try again later' } };
  }
};
