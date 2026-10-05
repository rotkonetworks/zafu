/**
 * The rune side of a two-sided position, as lp.html reads and sends it. Every
 * call here takes the pocket's thor1, which exists only after the person
 * chose "add with rune too" (lp/store.ts optInRune), and checks the thornode
 * destination first: with no opt-in nothing here is ever asked, and with
 * thornode off nothing leaves. The cosmos REST lives on the same THORNode
 * gateways (gateway.liquify.com/chain/thorchain_api/cosmos/...), so it is
 * the one thornode destination, no new host.
 *
 * Keys stay in the worker: `send` takes a signer that hands back a signed
 * TxRaw; this file simulates it first and only then broadcasts.
 */

import { ThornodeRefusal, thornodeGet, thornodePost, THORNODE_URLS } from '../services/thornode';
import { LP_POOL } from './math';
import { THOR_AFFILIATE, zafuFeeBps } from '../config/swap-fee';
import {
  checkMinimum,
  checkQuote,
  memoLimit,
  nodeRefusal,
  PRICE_TOLERANCE_BPS,
  ZEC_ASSET,
  type InboundAddress,
  type NodeQuote,
} from '../state/swap/thornode';
import { lpEgress, NotAllowed, THORNODE_DEST } from './thor';

/** liquify first: it answers the cosmos REST; the other node is only failover */
const NODES = [...THORNODE_URLS].reverse();

/** THORChain's native fee per tx, rune 1e8 (/thorchain/network native_tx_fee_rune), when unread */
export const RUNE_FEE = 2_000_000n;
/** kept back after an add: one take-out and one recovery, each a native fee */
export const reserveOf = (fee = RUNE_FEE): bigint => fee * 2n;

type Raw = Record<string, unknown>;

const big = (v: unknown): bigint => {
  try {
    return BigInt(String(v ?? '0').split('.')[0] || '0');
  } catch {
    return 0n;
  }
};

const allowed = async () => {
  if (!(await lpEgress()).thornode) {
    throw new NotAllowed(THORNODE_DEST);
  }
};

/** the two-sided position THORNode keeps under the thor1 (both addresses, both pendings) */
export interface PairedPosition {
  units: bigint;
  pendingRune: bigint;
  pendingAsset: bigint;
  pendingTxId?: string;
  runeAddress: string;
  assetAddress: string;
  depositAsset: bigint;
  depositRune: bigint;
  lastAddHeight: number;
  luviGrowthPct: number;
}

export const pairedOf = (lp: Raw): PairedPosition => ({
  units: big(lp['units']),
  pendingRune: big(lp['pending_rune']),
  pendingAsset: big(lp['pending_asset']),
  pendingTxId: lp['pending_tx_id'] ? String(lp['pending_tx_id']) : undefined,
  runeAddress: String(lp['rune_address'] ?? ''),
  assetAddress: String(lp['asset_address'] ?? ''),
  depositAsset: big(lp['asset_deposit_value']),
  depositRune: big(lp['rune_deposit_value']),
  lastAddHeight: Number(lp['last_add_height'] ?? 0),
  luviGrowthPct: Number(lp['luvi_growth_pct'] ?? 0) * 100,
});

/** anything to show: units, or a half waiting */
export const pairedLive = (p?: PairedPosition): p is PairedPosition =>
  !!p && (p.units > 0n || p.pendingRune > 0n || p.pendingAsset > 0n);

export interface RuneRead {
  at: number;
  address: string;
  /** spendable rune, 1e8 */
  balance: bigint;
  /** undefined until the account has ever held rune */
  account?: { accountNumber: string; sequence: string };
  paired?: PairedPosition;
  /** the native fee now */
  fee: bigint;
}

const notFound = (e: unknown) =>
  e instanceof ThornodeRefusal && (e.status === 404 || /not found/i.test(e.message));

/** the balance, the account and the paired position of `thor1` */
export const readRune = async (thor1: string, signal?: AbortSignal): Promise<RuneRead> => {
  await allowed();
  const [bal, acct, lp, network] = await Promise.all([
    thornodeGet<{ balance?: { amount?: string } }>(
      `/cosmos/bank/v1beta1/balances/${thor1}/by_denom?denom=rune`,
      NODES,
      signal,
    ),
    thornodeGet<{ account?: Raw }>(`/cosmos/auth/v1beta1/accounts/${thor1}`, NODES, signal).catch(
      (e: unknown): { account?: Raw } => {
        if (notFound(e)) {
          return {};
        }
        throw e;
      },
    ),
    thornodeGet<Raw>(`/thorchain/pool/${LP_POOL}/liquidity_provider/${thor1}`, NODES, signal).catch(
      (e: unknown) => {
        if (notFound(e)) {
          return undefined;
        }
        throw e;
      },
    ),
    thornodeGet<Raw>('/thorchain/network', NODES, signal).catch(() => ({}) as Raw),
  ]);
  const a = acct.account;
  const fee = big(network['native_tx_fee_rune']);
  return {
    at: Date.now(),
    address: thor1,
    balance: big(bal.balance?.amount),
    account:
      a && a['account_number'] !== undefined
        ? { accountNumber: String(a['account_number']), sequence: String(a['sequence'] ?? '0') }
        : undefined,
    paired: lp ? pairedOf(lp) : undefined,
    fee: fee > 0n ? fee : RUNE_FEE,
  };
};

export const NO_ACCOUNT_LINE =
  'this rune address has not held rune yet · please get some rune first · nothing was sent';

/**
 * Simulate, then broadcast, one signed MsgDeposit; its tx hash. The simulate
 * runs the whole deposit against the chain without spending anything, so a
 * memo or balance THORChain would refuse stops here, with nothing sent.
 */
export const sendRuneTx = async (
  txBytes: string,
  opts: { broadcast?: boolean; signal?: AbortSignal } = {},
): Promise<{ txhash?: string; gasUsed: bigint }> => {
  await allowed();
  const sim = await thornodePost<{ gas_info?: { gas_used?: string } }>(
    '/cosmos/tx/v1beta1/simulate',
    { tx_bytes: txBytes },
    NODES.slice(0, 1),
    opts.signal,
  ).catch((e: unknown) => {
    throw new Error(
      `thorchain would not take this: ${e instanceof Error ? e.message : 'no answer'} · nothing was sent`,
    );
  });
  const gasUsed = big(sim.gas_info?.gas_used);
  if (opts.broadcast === false) {
    return { gasUsed };
  }
  const r = await thornodePost<{
    tx_response?: { txhash?: string; code?: number; raw_log?: string };
  }>(
    '/cosmos/tx/v1beta1/txs',
    { tx_bytes: txBytes, mode: 'BROADCAST_MODE_SYNC' },
    NODES.slice(0, 1),
    opts.signal,
  );
  const t = r.tx_response;
  if (!t?.txhash || (t.code ?? 0) !== 0) {
    throw new Error(
      `thorchain refused the rune deposit (code ${t?.code ?? '?'}) · nothing was sent`,
    );
  }
  return { txhash: t.txhash.toUpperCase(), gasUsed };
};

/** a zec -> rune quote, paid to the pocket's thor1; checked like the swap screen's */
export interface RuneQuote {
  at: number;
  amountZat: bigint;
  /** after THORChain's fees, 1e8 */
  runeOut: bigint;
  /** the price limit the memo carries, 1e8 */
  atLeast: bigint;
  memo: string;
  vault: string;
  /** THORChain's whole fee, in rune */
  feeRune: bigint;
  seconds?: number;
  expiry: number;
}

/**
 * Ask THORNode for zec -> rune to `thor1`, with zafu's affiliate as the swap
 * screen sends it, and refuse what the swap screen refuses: a vault that is
 * not the listed one, a memo past 80 bytes or naming another address, no
 * price limit, an amount under the minimum.
 */
export const quoteRune = async (
  amountZat: bigint,
  thor1: string,
  signal?: AbortSignal,
): Promise<RuneQuote> => {
  await allowed();
  const name = 'thorchain';
  const query = new URLSearchParams({
    from_asset: ZEC_ASSET,
    to_asset: 'THOR.RUNE',
    amount: amountZat.toString(),
    destination: thor1,
    streaming_interval: '1',
    liquidity_tolerance_bps: String(PRICE_TOLERANCE_BPS),
    affiliate: THOR_AFFILIATE,
    affiliate_bps: String(zafuFeeBps('thor')),
  });
  const [q, inbound] = await Promise.all([
    thornodeGet<NodeQuote>(`/thorchain/quote/swap?${query}`, NODES, signal),
    thornodeGet<InboundAddress[]>('/thorchain/inbound_addresses', NODES, signal),
  ]).catch((e: unknown) => {
    throw nodeRefusal(name, e, amountZat, 'zec');
  });
  checkQuote(name, q, inbound, 'ZEC', true, thor1);
  checkMinimum(name, q, inbound.find(a => a.chain === 'ZEC')!, amountZat, 'zec');
  return {
    at: Date.now(),
    amountZat,
    runeOut: big(q.expected_amount_out),
    atLeast: memoLimit(q.memo),
    memo: q.memo,
    vault: q.inbound_address,
    feeRune: big(q.fees.total),
    seconds: q.total_swap_seconds,
    expiry: q.expiry * 1000,
  };
};

/** has THORChain paid a swap out: its swap is final and nothing is left to send (tx/status) */
export const readSwapped = async (txid: string, signal?: AbortSignal): Promise<boolean> => {
  await allowed();
  const s = await thornodeGet<{
    stages?: Record<string, { completed?: boolean; pending?: boolean }>;
  }>(`/thorchain/tx/status/${txid.toUpperCase()}`, NODES, signal).catch(
    () => ({}) as { stages?: undefined },
  );
  const st = s.stages;
  return (
    !!st?.['swap_finalised']?.completed &&
    !st['swap_status']?.pending &&
    st['outbound_signed']?.completed !== false
  );
};

/** a rune MsgDeposit by hash: included (code 0), refused on chain, or nowhere THORNode knows */
export const readRuneTx = async (
  hash: string,
  signal?: AbortSignal,
): Promise<{ state: 'included' | 'failed' | 'missing'; log?: string }> => {
  await allowed();
  try {
    const r = await thornodeGet<{ tx_response?: { code?: number; raw_log?: string } }>(
      `/cosmos/tx/v1beta1/txs/${hash.toUpperCase()}`,
      NODES,
      signal,
    );
    const code = r.tx_response?.code ?? 0;
    return code === 0
      ? { state: 'included' }
      : { state: 'failed', log: r.tx_response?.raw_log || `code ${code}` };
  } catch (e) {
    if (notFound(e)) {
      return { state: 'missing' };
    }
    throw e;
  }
};
