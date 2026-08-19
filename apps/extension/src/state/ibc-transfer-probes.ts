/**
 * Destination-balance probes for the IBC transfer tracker.
 *
 * These wire the pure tracker core (ibc-transfer-tracker.ts) to the EXISTING
 * balance/note query paths - no new RPC endpoints:
 *   - shield-in  (Noble USDC -> Penumbra): the Penumbra view service balances,
 *     the same `viewClient.balances({ accountFilter })` the send screen already
 *     iterates. The deposit lands as an IBC voucher asset, so we match by the
 *     asset's display SYMBOL (e.g. "USDC") rather than the source cosmos denom.
 *   - unshield-out (Penumbra -> Noble): the cosmos balance at the burner /
 *     recipient address, via `getAllBalances` - the same client cosmos-balance.ts
 *     uses.
 *
 * The core is client-agnostic; `makeIbcProbe` takes an injectable Penumbra
 * balance fetcher so the popup can pass the page `viewClient` and the service
 * worker can pass its internal direct client.
 */

import type { BalancesResponse } from '@penumbra-zone/protobuf/penumbra/view/v1/view_pb';
import { getMetadataFromBalancesResponse } from '@penumbra-zone/getters/balances-response';
import { getAmount as getAmountFromView } from '@penumbra-zone/getters/value-view';
import { joinLoHiAmount } from '@rotko/penumbra-types/amount';
import { COSMOS_CHAINS, type CosmosChainId } from '@repo/wallet/networks/cosmos/chains';

/**
 * Read a cosmos address's balances over plain REST - NOT via
 * `@repo/wallet cosmos/client` `getAllBalances`, which uses `@cosmjs/stargate`
 * and pulls `@cosmjs/crypto` -> Node `crypto` into the SERVICE-WORKER bundle
 * (which is not crypto-polyfilled, unlike the popup) and breaks the webpack
 * build. This probe only reads a balance, so a bare `fetch` to the bank REST
 * endpoint is both worker-safe and lighter. Returns the same shape
 * `matchCosmosBalance` expects.
 */
const fetchCosmosBalancesRest = async (
  chainId: CosmosChainId,
  address: string,
): Promise<{ denom: string; amount: bigint }[]> => {
  const base = COSMOS_CHAINS[chainId].restEndpoint.replace(/\/+$/, '');
  const res = await fetch(`${base}/cosmos/bank/v1beta1/balances/${address}`);
  if (!res.ok) {
    throw new Error(`cosmos balance query failed: ${res.status}`);
  }
  const data = (await res.json()) as { balances?: { denom: string; amount: string }[] };
  return (data.balances ?? []).map(b => ({ denom: b.denom, amount: BigInt(b.amount) }));
};

/**
 * Decimal amount string -> base-unit string. Inlined (identical to the helper in
 * @repo/wallet cosmos/signer) so this probe never imports the cosmos SIGNER
 * module, which pulls in @cosmjs/crypto -> Node `crypto` and breaks the webpack
 * browser bundle. This probe only reads balances; it must not drag in signing.
 */
const parseAmountToBaseUnits = (amount: string, decimals: number): string => {
  const [whole = '0', frac = ''] = amount.split('.');
  const padded = frac.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole + padded).toString();
};
import { viewClient } from '../clients';
import {
  track,
  defaultTrackerDeps,
  type DestinationProbe,
  type IbcTransfer,
  type NewTransfer,
} from './ibc-transfer-tracker';

/** two days in ms - the ICS20 withdrawal timeout (ibc-withdraw.ts) */
export const UNSHIELD_TIMEOUT_MS = 2 * 24 * 60 * 60 * 1000;
/** ten minutes in ms - the cosmos MsgTransfer packet timeout (cosmos-signer.ts) */
export const SHIELD_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Grace added on top of the shield packet timeout before we PRESUME a timeout.
 * Arrival is detected via the Penumbra view service, which only reflects the
 * note once the block processor has scanned that block - and background sync
 * runs on a 30-min alarm. Without this grace a note that landed on-chain inside
 * the 10-min window but was scanned late would flash "not seen" until the next
 * poll catches up. (The timeout state is recoverable, so this only affects the
 * copy shown, never correctness.)
 */
export const SHIELD_DETECTION_GRACE_MS = 30 * 60 * 1000;

/** fetch the raw balances for a penumbra account (injectable per context) */
export type PenumbraBalanceFetch = (account: number) => Promise<BalancesResponse[]>;

/** page-side fetcher: the same channel-transport view client the UI uses */
const uiPenumbraBalances: PenumbraBalanceFetch = account =>
  Array.fromAsync(viewClient.balances({ accountFilter: { account } }));

/**
 * Sum the base-unit balance of every asset in `responses` whose display symbol
 * matches `symbol` (case-insensitive). Bridged USDC arrives under a voucher
 * denom, so symbol is the stable key.
 */
export const matchPenumbraBalance = (responses: BalancesResponse[], symbol: string): bigint => {
  const want = symbol.toUpperCase();
  let total = 0n;
  for (const b of responses) {
    const meta = getMetadataFromBalancesResponse.optional(b);
    const sym = (meta?.symbol ?? meta?.display ?? '').toUpperCase();
    // substring match tolerates the voucher symbol differing from the source
    // (e.g. a "USDC" prefix/suffix); baseline and probe sum the same set, so an
    // over-broad match mostly self-cancels via the baseline delta.
    if (sym && (sym === want || sym.includes(want))) {
      const amount = getAmountFromView(b.balanceView);
      if (amount) {
        total += joinLoHiAmount(amount);
      }
    }
  }
  return total;
};

/**
 * Sum the destination cosmos balance. When `denom` is known we match it exactly;
 * otherwise (unusual asset) we sum every denom at the address - a burner is
 * single-purpose, so the total is a reasonable arrival signal.
 */
export const matchCosmosBalance = (
  balances: { denom: string; amount: bigint }[],
  denom?: string,
): bigint => {
  if (!denom) {
    return balances.reduce((sum, b) => sum + b.amount, 0n);
  }
  return balances.filter(b => b.denom === denom).reduce((sum, b) => sum + b.amount, 0n);
};

/** build a direction-aware destination probe from a penumbra balance fetcher */
export const makeIbcProbe =
  (fetchPenumbraBalances: PenumbraBalanceFetch): DestinationProbe =>
  async (t: IbcTransfer) => {
    if (t.direction === 'shield') {
      if (t.destAccount === undefined || !t.matchSymbol) {
        return undefined;
      }
      const responses = await fetchPenumbraBalances(t.destAccount);
      return matchPenumbraBalance(responses, t.matchSymbol);
    }
    // unshield: poll the cosmos destination address
    if (!t.destChainId || !t.destAddress) {
      return undefined;
    }
    const balances = await fetchCosmosBalancesRest(t.destChainId as CosmosChainId, t.destAddress);
    return matchCosmosBalance(balances, t.destDenom);
  };

/** the probe the popup uses (page view client + cosmos client) */
export const uiIbcProbe: DestinationProbe = makeIbcProbe(uiPenumbraBalances);

/** record a shield-in (Noble USDC -> Penumbra) after source broadcast */
export const trackShieldIn = (args: {
  srcTxHash: string;
  /** display amount the user entered (e.g. "5.5") */
  amount: string;
  /** decimals of the source asset (6 for USDC) */
  decimals: number;
  /** asset display symbol, matched on the penumbra side (e.g. "USDC") */
  symbol: string;
  /** penumbra account the note lands in */
  penumbraAccount: number;
  now?: number;
}): Promise<IbcTransfer> => {
  const now = args.now ?? Date.now();
  const input: NewTransfer = {
    id: args.srcTxHash,
    direction: 'shield',
    amount: parseAmountToBaseUnits(args.amount, args.decimals),
    denom: args.symbol,
    srcTxHash: args.srcTxHash,
    expiresAt: now + SHIELD_TIMEOUT_MS + SHIELD_DETECTION_GRACE_MS,
    destAccount: args.penumbraAccount,
    matchSymbol: args.symbol,
  };
  return track(input, uiIbcProbe, defaultTrackerDeps());
};

/** record an unshield-out (Penumbra -> Noble) after source broadcast */
export const trackUnshieldOut = (args: {
  srcTxHash: string;
  amount: string;
  decimals: number;
  symbol: string;
  /** cosmos chain id of the destination (e.g. "noble") */
  destChainId: CosmosChainId;
  /** destination address (burner or override recipient) */
  destAddress: string;
  /** whether the asset is the chain's native token (USDC on Noble) - lets us
   *  match the exact denom; otherwise the probe sums all balances */
  isNative: boolean;
  now?: number;
}): Promise<IbcTransfer> => {
  const now = args.now ?? Date.now();
  const input: NewTransfer = {
    id: args.srcTxHash,
    direction: 'unshield',
    amount: parseAmountToBaseUnits(args.amount, args.decimals),
    denom: args.symbol,
    srcTxHash: args.srcTxHash,
    expiresAt: now + UNSHIELD_TIMEOUT_MS,
    destChainId: args.destChainId,
    destAddress: args.destAddress,
    destDenom: args.isNative ? COSMOS_CHAINS[args.destChainId].denom : undefined,
  };
  return track(input, uiIbcProbe, defaultTrackerDeps());
};
