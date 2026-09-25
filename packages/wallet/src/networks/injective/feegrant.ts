/**
 * Injective gas sponsorship via the cosmos x/feegrant module.
 *
 * Injective only accepts INJ for gas (minimum_gas_price is inj-only), so a user
 * who withdrew USDC.inj from an exchange cannot move it until they also buy
 * INJ. A granter account (run by us, see apps/feegrant) can instead issue each
 * such address a small, time-boxed allowance scoped to IBC MsgTransfer; the
 * user's shield-in then sets `fee.granter` and pays nothing in INJ.
 *
 * Verified against mainnet: a MsgTransfer naming a granter with no allowance
 * is rejected by the ante handler with "fee-grant not found", so the chain
 * enforces the grant rather than silently charging the signer.
 *
 * Privacy: both the grant and every sponsored tx are public and name the
 * granter, so a sponsored shield is visibly made with this tooling. The shield
 * transfer itself is already public on Injective; this adds a fingerprint, not
 * a new deanonymization.
 */

import { MsgGrantAllowance, MsgRevokeAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/tx';
import { AllowedMsgAllowance, BasicAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/feegrant';
import { Timestamp } from 'cosmjs-types/google/protobuf/timestamp';
import type { Coin } from 'cosmjs-types/cosmos/base/v1beta1/coin';
import type { EncodedMsg } from './tx';

type FetchFn = typeof fetch;

export const MSG_TRANSFER_TYPE_URL = '/ibc.applications.transfer.v1.MsgTransfer';
/** a plain bank send - the withdraw-to-exchange leg */
export const MSG_SEND_TYPE_URL = '/cosmos.bank.v1beta1.MsgSend';

/**
 * Penumbra-accepted stablecoins on Injective (all 6-dec). Holding at least one
 * unit of any of these qualifies an address for gas sponsorship. Stablecoins
 * only: an unpriced token would let anyone qualify with dust.
 */
export const INJECTIVE_STABLE_DENOMS: readonly string[] = [
  'erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a', // USDC.inj
  'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
  'factory/inj1n636d9gzrqggdk66n2f97th0x8yuhfrtx520e7/ausd', // AUSD
  'inj1cy9hes20vww2yr6crvs75gxy5hpycya2hmjg9s', // nUSDT
  'inj1dafy7fv7qczzatd98dv8hekx6ssckrflswpjaz', // nUSDC
];
export const MIN_SPONSOR_STABLE = 1_000_000n; // one unit

/** does this balance list qualify for sponsorship? */
export const holdsSponsorStable = (
  balances: readonly { denom: string; amount: bigint }[],
  denoms: readonly string[] = INJECTIVE_STABLE_DENOMS,
  min: bigint = MIN_SPONSOR_STABLE,
): boolean => {
  const set = new Set(denoms.map(d => d.toLowerCase()));
  return balances.some(b => set.has(b.denom.toLowerCase()) && b.amount >= min);
};

/** what the gas is for: shielding into Penumbra (IBC) or sending out (bank send) */
export type FeeGrantPurpose = 'shield' | 'send';
const MSG_GRANT_ALLOWANCE_TYPE_URL = '/cosmos.feegrant.v1beta1.MsgGrantAllowance';
const MSG_REVOKE_ALLOWANCE_TYPE_URL = '/cosmos.feegrant.v1beta1.MsgRevokeAllowance';
const BASIC_ALLOWANCE_TYPE_URL = '/cosmos.feegrant.v1beta1.BasicAllowance';
const ALLOWED_MSG_ALLOWANCE_TYPE_URL = '/cosmos.feegrant.v1beta1.AllowedMsgAllowance';

const trimUrl = (u: string) => u.replace(/\/$/, '');

export interface GrantAllowanceParams {
  granter: string;
  grantee: string;
  /** Total fees the grantee may spend from the granter, e.g. [{ denom: 'inj', amount: '1000000000000000' }]. */
  spendLimit: Coin[];
  /** Allowance stops working after this instant. */
  expiration: Date;
  /** Message type URLs the allowance may pay for (e.g. MSG_TRANSFER_TYPE_URL only). */
  allowedMessages: string[];
}

/**
 * MsgGrantAllowance wrapping AllowedMsgAllowance(BasicAllowance). The message
 * filter means the sponsor pays only for the listed message types; the spend
 * limit and expiration bound what any one grantee can cost.
 */
export function buildMsgGrantAllowance(p: GrantAllowanceParams): EncodedMsg {
  const basic = BasicAllowance.encode(
    BasicAllowance.fromPartial({
      spendLimit: p.spendLimit,
      expiration: Timestamp.fromPartial({
        seconds: BigInt(Math.floor(p.expiration.getTime() / 1000)),
        nanos: 0,
      }),
    }),
  ).finish();

  const allowed = AllowedMsgAllowance.encode(
    AllowedMsgAllowance.fromPartial({
      allowance: { typeUrl: BASIC_ALLOWANCE_TYPE_URL, value: basic },
      allowedMessages: p.allowedMessages,
    }),
  ).finish();

  return {
    typeUrl: MSG_GRANT_ALLOWANCE_TYPE_URL,
    value: MsgGrantAllowance.encode(
      MsgGrantAllowance.fromPartial({
        granter: p.granter,
        grantee: p.grantee,
        allowance: { typeUrl: ALLOWED_MSG_ALLOWANCE_TYPE_URL, value: allowed },
      }),
    ).finish(),
  };
}

/**
 * MsgRevokeAllowance. MsgGrantAllowance fails if ANY allowance already exists
 * for the pair, so an exhausted or expired grant must be revoked (in the same
 * tx) before a fresh one can be issued.
 */
export function buildMsgRevokeAllowance(granter: string, grantee: string): EncodedMsg {
  return {
    typeUrl: MSG_REVOKE_ALLOWANCE_TYPE_URL,
    value: MsgRevokeAllowance.encode(MsgRevokeAllowance.fromPartial({ granter, grantee })).finish(),
  };
}

export interface FeeAllowanceInfo {
  /** Remaining spend limit (the chain decrements it as fees are paid). Empty = unlimited. */
  spendLimit: Coin[];
  expiration?: Date;
  /** Empty when the allowance is not message-filtered. */
  allowedMessages: string[];
}

interface AllowanceJson {
  '@type'?: string;
  allowance?: AllowanceJson;
  spend_limit?: { denom?: string; amount?: string }[];
  expiration?: string | null;
  allowed_messages?: string[];
}

/**
 * The allowance `granter` has issued to `grantee`, or null if none.
 *
 * Uses the per-grantee list endpoint (always 200) rather than the single-pair
 * endpoint, which reports "not found" as an HTTP error.
 */
export async function queryFeeAllowance(
  restUrl: string,
  granter: string,
  grantee: string,
  fetchFn: FetchFn = fetch,
): Promise<FeeAllowanceInfo | null> {
  const res = await fetchFn(`${trimUrl(restUrl)}/cosmos/feegrant/v1beta1/allowances/${grantee}`);
  if (!res.ok) {
    throw new Error(`injective feegrant query failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    allowances?: { granter?: string; grantee?: string; allowance?: AllowanceJson }[];
  };
  const grant = (json.allowances ?? []).find(a => a.granter === granter);
  if (!grant?.allowance) {
    return null;
  }

  // AllowedMsgAllowance wraps the BasicAllowance that carries limit + expiry.
  const outer = grant.allowance;
  const basic = outer['@type'] === ALLOWED_MSG_ALLOWANCE_TYPE_URL ? outer.allowance : outer;
  return {
    spendLimit: (basic?.spend_limit ?? [])
      .filter((c): c is { denom: string; amount: string } => !!c.denom && c.amount != null)
      .map(c => ({ denom: c.denom, amount: c.amount })),
    expiration: basic?.expiration ? new Date(basic.expiration) : undefined,
    allowedMessages: outer.allowed_messages ?? [],
  };
}

/**
 * True when the allowance can still pay one more fee of `fee` for `messageType`
 * and will not expire within `marginMs`.
 */
export function allowanceCovers(
  info: FeeAllowanceInfo,
  fee: Coin,
  messageType: string,
  now: Date = new Date(),
  marginMs = 60_000,
): boolean {
  if (info.expiration && info.expiration.getTime() <= now.getTime() + marginMs) {
    return false;
  }
  if (info.allowedMessages.length > 0 && !info.allowedMessages.includes(messageType)) {
    return false;
  }
  if (info.spendLimit.length === 0) {
    return true;
  }
  const remaining = info.spendLimit.find(c => c.denom === fee.denom);
  return !!remaining && BigInt(remaining.amount) >= BigInt(fee.amount);
}

// -- client: ask the sponsor service for a grant ------------------------------

export interface FeeGrantResult {
  /** inj1 address to put in fee.granter */
  granter: string;
  /** 'granted' = a new grant was included on-chain; 'exists' = a usable one was already there */
  status: 'granted' | 'exists';
  txhash?: string;
  height?: string;
  expiresAt?: string;
}

/**
 * Ask the gas-sponsor service (apps/feegrant) to cover `address`. Resolves only
 * once the grant is usable on-chain, so the caller can build its tx with
 * `feeGranter = result.granter` immediately.
 */
export async function requestInjectiveFeeGrant(
  serviceUrl: string,
  address: string,
  fetchFn: FetchFn = fetch,
  /** older sponsors ignore this and grant for shielding only */
  purpose: FeeGrantPurpose = 'shield',
): Promise<FeeGrantResult> {
  const res = await fetchFn(`${trimUrl(serviceUrl)}/v1/injective/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, purpose }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<FeeGrantResult> & {
    error?: string;
  };
  if (!res.ok || !json.granter || !json.status) {
    throw new Error(json.error ?? `gas sponsor unavailable (HTTP ${res.status})`);
  }
  return json as FeeGrantResult;
}
